#!/usr/bin/env python3
"""
tmdb_match.py — Match USCCB film reviews to TMDB (The Movie Database) IDs.

What it does
------------
Reads the exported `films.json`, and for each film searches TMDB by title + year,
scores the candidates, and writes a `tmdb_matches.csv` mapping every film to its
best TMDB id (plus a confidence score and a status you can review).

It is **resumable**: if it stops (network drop, rate limit, Ctrl-C), just run it
again with the same arguments and it picks up where it left off, skipping films
already written to the output file.

Requirements
------------
    pip install requests

A free TMDB API key (v3) or API Read Access Token (v4):
    1. Create a free account at https://www.themoviedb.org/
    2. Settings -> API -> request a Developer key (instant).
    3. Copy either the "API Key (v3 auth)" or the "API Read Access Token (v4 auth)".

Usage
-----
    export TMDB_API_KEY="your_key_or_token_here"
    python3 tmdb_match.py --input export/films.json --out tmdb_matches.csv

    # or pass the key directly, and test on the first 50 films:
    python3 tmdb_match.py --api-key YOUR_KEY --limit 50

Output columns (tmdb_matches.csv)
---------------------------------
    id, slug, usccb_title, usccb_year,
    tmdb_id, tmdb_title, tmdb_year, tmdb_release_date,
    score, status, poster_path, overview, genre_ids

  poster_path / overview / genre_ids come straight from the TMDB search hit (no
  extra requests). genre_ids is ';'-joined TMDB genre ids. These feed
  scripts/apply_tmdb.mjs, which writes them into Postgres.

  status is one of:
    matched          - confident match (score >= --min-score and year within tolerance)
    low_confidence   - a candidate was found but it's weak; review manually
    no_result        - TMDB returned nothing for this title

After running, filter the CSV by status to review `low_confidence` / `no_result`
rows. Then you can fold `tmdb_id` back into the database / exports (see README).
"""

import argparse, csv, json, os, re, sys, time, difflib

API = "https://api.themoviedb.org/3/search/movie"

# Trailing articles USCCB stores as ", The" / ", A" etc. TMDB expects them up front.
ARTICLES = ("The", "A", "An", "La", "Le", "Les", "Il", "Lo", "El", "Las", "Los", "Der", "Die", "Das", "L'", "Un", "Une")


def front_article(title: str) -> str:
    """'War of the Roses, The' -> 'The War of the Roses'."""
    m = re.match(r'^(.*),\s*(' + '|'.join(re.escape(a) for a in ARTICLES) + r')\.?$', title.strip())
    if m:
        art = m.group(2)
        sep = '' if art.endswith("'") else ' '
        return f"{art}{sep}{m.group(1).strip()}"
    return title.strip()


def norm(title: str) -> str:
    """Aggressive normalization for similarity scoring."""
    t = front_article(title).lower()
    t = re.sub(r'\(\d{4}\)', '', t)          # drop a trailing year in parens
    t = re.sub(r'[^a-z0-9]+', ' ', t)        # punctuation -> space
    return re.sub(r'\s+', ' ', t).strip()


def auth(session, key):
    """Support both v3 api_key (query param) and v4 bearer token (header)."""
    key = key.strip()
    if key.count('.') >= 2 and len(key) > 60:   # looks like a JWT -> v4 bearer
        session.headers.update({"Authorization": f"Bearer {key}"})
        return {}
    return {"api_key": key}                       # v3 key -> query param


def tmdb_search(session, base_params, title, year=None, retries=4):
    import requests
    params = dict(base_params)
    params["query"] = front_article(title)
    params["include_adult"] = "true"
    if year:
        params["year"] = year
    for attempt in range(retries):
        try:
            r = session.get(API, params=params, timeout=20)
        except requests.RequestException:
            time.sleep(1.5 * (attempt + 1)); continue
        if r.status_code == 429:                       # rate limited
            wait = int(r.headers.get("Retry-After", "2")) + 1
            time.sleep(wait); continue
        if r.status_code == 401:
            sys.exit("ERROR: TMDB rejected the key/token (401). Check --api-key / TMDB_API_KEY.")
        if r.status_code != 200:
            time.sleep(1.0 * (attempt + 1)); continue
        return r.json().get("results", [])
    return []


def year_of(result):
    d = result.get("release_date") or ""
    m = re.match(r'(\d{4})', d)
    return int(m.group(1)) if m else None


def best_match(usccb_title, usccb_year, results):
    """Score candidates: title similarity (0-1) + year proximity bonus."""
    target = norm(usccb_title)
    best, best_score = None, -1.0
    for res in results:
        cand_title = res.get("title") or res.get("original_title") or ""
        sim = difflib.SequenceMatcher(None, target, norm(cand_title)).ratio()
        ry = year_of(res)
        ybonus = 0.0
        if usccb_year and ry:
            diff = abs(usccb_year - ry)
            ybonus = 0.15 if diff == 0 else (0.07 if diff == 1 else (-0.25 if diff > 3 else 0.0))
        # popularity tiebreaker (tiny weight)
        pop = min(res.get("popularity", 0) / 1000.0, 0.03)
        score = sim + ybonus + pop
        if score > best_score:
            best, best_score = res, score
    return best, round(min(best_score, 1.0), 3)


def load_done(out_path):
    done = set()
    if os.path.exists(out_path):
        with open(out_path, newline='', encoding='utf-8') as fh:
            for row in csv.DictReader(fh):
                if row.get("id"):
                    done.add(int(row["id"]))
    return done


def main():
    ap = argparse.ArgumentParser(description="Match USCCB films to TMDB ids.")
    ap.add_argument("--input", default="export/films.json")
    ap.add_argument("--out", default="tmdb_matches.csv")
    ap.add_argument("--api-key", default=os.environ.get("TMDB_API_KEY"))
    ap.add_argument("--min-score", type=float, default=0.72, help="threshold for 'matched' status")
    ap.add_argument("--year-tolerance", type=int, default=2)
    ap.add_argument("--limit", type=int, default=0, help="only process first N (0 = all)")
    ap.add_argument("--sleep", type=float, default=0.05, help="seconds between requests")
    ap.add_argument("--skip-redirects", action="store_true", default=True)
    args = ap.parse_args()

    if not args.api_key:
        sys.exit("ERROR: no API key. Set TMDB_API_KEY or pass --api-key.")
    try:
        import requests
    except ImportError:
        sys.exit("ERROR: install requests first:  pip install requests")

    films = json.load(open(args.input, encoding='utf-8'))
    if args.limit:
        films = films[:args.limit]

    session = requests.Session()
    base_params = auth(session, args.api_key)

    done = load_done(args.out)
    write_header = not os.path.exists(args.out)
    fh = open(args.out, "a", newline='', encoding='utf-8')
    w = csv.writer(fh)
    if write_header:
        w.writerow(["id","slug","usccb_title","usccb_year","tmdb_id","tmdb_title",
                    "tmdb_year","tmdb_release_date","score","status",
                    "poster_path","overview","genre_ids"])

    stats = {"matched":0,"low_confidence":0,"no_result":0,"skipped":0}
    total = len(films)
    processed = 0
    for film in films:
        fid = film["id"]
        if fid in done:
            continue
        if args.skip_redirects and film.get("is_redirect"):
            w.writerow([fid, film["slug"], film.get("title",""), film.get("year",""),
                        "", "", "", "", "", "skipped_redirect", "", "", ""])
            stats["skipped"] += 1; continue

        title = film.get("title") or ""
        yr = film.get("year")
        results = tmdb_search(session, base_params, title, yr)
        if not results and yr:                       # retry without the year filter
            results = tmdb_search(session, base_params, title, None)

        if not results:
            w.writerow([fid, film["slug"], title, yr or "", "", "", "", "", "", "no_result", "", "", ""])
            stats["no_result"] += 1
        else:
            best, score = best_match(title, yr, results)
            by = year_of(best)
            year_ok = (not yr) or (by and abs(yr - by) <= args.year_tolerance)
            status = "matched" if (score >= args.min_score and year_ok) else "low_confidence"
            genre_ids = ";".join(str(g) for g in (best.get("genre_ids") or []))
            w.writerow([fid, film["slug"], title, yr or "",
                        best.get("id"), best.get("title"), by or "",
                        best.get("release_date",""), score, status,
                        best.get("poster_path") or "", best.get("overview") or "", genre_ids])
            stats[status] += 1

        processed += 1
        if processed % 100 == 0:
            fh.flush()
            print(f"  {processed} new / {total} total | "
                  f"matched={stats['matched']} low={stats['low_confidence']} none={stats['no_result']}",
                  file=sys.stderr)
        time.sleep(args.sleep)

    fh.close()
    print("\nDone.")
    print(f"  newly processed : {processed}")
    for k, v in stats.items():
        print(f"  {k:16s}: {v}")
    print(f"\nWrote {args.out}. Review rows where status != 'matched'.")


if __name__ == "__main__":
    main()
