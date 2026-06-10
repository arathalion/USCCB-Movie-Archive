#!/usr/bin/env python3
"""
apply_tmdb.py — Fold TMDB ids from tmdb_matches.csv back into all the deliverables.

Run this AFTER tmdb_match.py has produced tmdb_matches.csv. It adds a `tmdb_id`
to:
  - movies.db            (new column `tmdb_id`)
  - export/films.json    (new top-level field `tmdb_id`)
  - export/films_full.csv and export/films_full.ndjson  (new `tmdb_id` column/field)
  - export/reviews/{id}.json  (new `tmdb_id` field, where a review file exists)

It is idempotent — safe to run multiple times (re-run after improving matches).
By default only rows with status `matched` are applied; add --include-low to also
apply `low_confidence` matches.

Usage
-----
    python3 apply_tmdb.py
    python3 apply_tmdb.py --include-low
    python3 apply_tmdb.py --matches tmdb_matches.csv --db movies.db --export-dir export
"""

import argparse, csv, json, os, sqlite3, sys


def load_matches(path, include_low):
    allowed = {"matched"} | ({"low_confidence"} if include_low else set())
    out = {}
    with open(path, newline='', encoding='utf-8') as fh:
        for row in csv.DictReader(fh):
            tid = (row.get("tmdb_id") or "").strip()
            if row.get("status") in allowed and tid:
                try:
                    out[int(row["id"])] = int(tid)
                except ValueError:
                    pass
    return out


def update_db(db_path, mapping):
    if not os.path.exists(db_path):
        print(f"  skip db: {db_path} not found"); return 0
    con = sqlite3.connect(db_path)
    cols = [r[1] for r in con.execute("PRAGMA table_info(reviews)")]
    if "tmdb_id" not in cols:
        con.execute("ALTER TABLE reviews ADD COLUMN tmdb_id INTEGER")
    con.execute("UPDATE reviews SET tmdb_id = NULL")
    n = 0
    for fid, tid in mapping.items():
        con.execute("UPDATE reviews SET tmdb_id = ? WHERE id = ?", (tid, fid))
        n += 1
    con.commit(); con.close()
    return n


def update_films_json(path, mapping):
    if not os.path.exists(path):
        print(f"  skip films.json: {path} not found"); return 0
    films = json.load(open(path, encoding='utf-8'))
    n = 0
    for f in films:
        tid = mapping.get(f["id"])
        f["tmdb_id"] = tid
        if tid is not None:
            n += 1
    json.dump(films, open(path, "w", encoding='utf-8'), ensure_ascii=False)
    return n


def update_csv(path, mapping):
    if not os.path.exists(path):
        print(f"  skip csv: {path} not found"); return 0
    with open(path, newline='', encoding='utf-8') as fh:
        rows = list(csv.reader(fh))
    header = rows[0]
    if "tmdb_id" not in header:
        header.append("tmdb_id")
    ti = header.index("tmdb_id")
    id_idx = rows[0].index("id") if "id" in rows[0] else 0
    n = 0
    out = [header]
    for r in rows[1:]:
        while len(r) < len(header):
            r.append("")
        try:
            tid = mapping.get(int(r[id_idx]))
        except ValueError:
            tid = None
        r[ti] = str(tid) if tid is not None else ""
        if tid is not None:
            n += 1
        out.append(r)
    with open(path, "w", newline='', encoding='utf-8') as fh:
        csv.writer(fh).writerows(out)
    return n


def update_ndjson(path, mapping):
    if not os.path.exists(path):
        print(f"  skip ndjson: {path} not found"); return 0
    n = 0
    lines = []
    with open(path, encoding='utf-8') as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            o = json.loads(line)
            tid = mapping.get(o.get("id"))
            o["tmdb_id"] = tid
            if tid is not None:
                n += 1
            lines.append(json.dumps(o, ensure_ascii=False))
    with open(path, "w", encoding='utf-8') as fh:
        fh.write("\n".join(lines) + "\n")
    return n


def update_reviews(reviews_dir, mapping):
    if not os.path.isdir(reviews_dir):
        print(f"  skip reviews: {reviews_dir} not found"); return 0
    n = 0
    for fid, tid in mapping.items():
        p = os.path.join(reviews_dir, f"{fid}.json")
        if os.path.exists(p):
            o = json.load(open(p, encoding='utf-8'))
            o["tmdb_id"] = tid
            json.dump(o, open(p, "w", encoding='utf-8'), ensure_ascii=False, indent=2)
            n += 1
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--matches", default="tmdb_matches.csv")
    ap.add_argument("--db", default="movies.db")
    ap.add_argument("--export-dir", default="export")
    ap.add_argument("--include-low", action="store_true",
                    help="also apply low_confidence matches (default: matched only)")
    args = ap.parse_args()

    if not os.path.exists(args.matches):
        sys.exit(f"ERROR: {args.matches} not found. Run tmdb_match.py first.")

    mapping = load_matches(args.matches, args.include_low)
    print(f"Loaded {len(mapping)} TMDB ids "
          f"({'matched + low_confidence' if args.include_low else 'matched only'}).")

    ex = args.export_dir
    print("Applying:")
    print(f"  movies.db          : {update_db(args.db, mapping)} rows tagged")
    print(f"  films.json         : {update_films_json(os.path.join(ex,'films.json'), mapping)} tagged")
    print(f"  films_full.csv     : {update_csv(os.path.join(ex,'films_full.csv'), mapping)} tagged")
    print(f"  films_full.ndjson  : {update_ndjson(os.path.join(ex,'films_full.ndjson'), mapping)} tagged")
    print(f"  reviews/*.json     : {update_reviews(os.path.join(ex,'reviews'), mapping)} tagged")
    print("\nDone. (Re-runnable — running again refreshes from the current matches CSV.)")


if __name__ == "__main__":
    main()
