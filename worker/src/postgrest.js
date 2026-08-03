// Translates the PostgREST query-string dialect documented in docs/api.md into
// SQLite/D1 SQL. This exists so the public API keeps working after the move off
// Supabase — an external site depends on the documented contract.
//
// Security model: every identifier (resource, column, direction) is checked
// against the whitelists below and never interpolated from user input;
// every *value* is bound as a parameter. There is no path from a query string
// to raw SQL text.

// Columns each resource exposes. Anything not listed is rejected outright,
// which doubles as the injection guard for select/order/filter identifiers.
const RESOURCES = {
  public_movies_api: [
    'id', 'slug', 'title', 'year', 'usccb_code', 'mpaa_rating', 'synopsis',
    'tmdb_id', 'poster_path', 'tmdb_release_date', 'overview', 'genres',
  ],
  movies: [
    'id', 'slug', 'title', 'year', 'usccb_code', 'mpaa_rating', 'synopsis',
    'full_review', 'letter', 'source_file',
  ],
  redirects: [
    'id', 'slug', 'title', 'synopsis', 'letter', 'source_file',
    'target_title', 'target_movie_id',
  ],
  usccb_ratings: ['code', 'label', 'description', 'sort_order'],
  genres: ['id', 'name'],
  movie_genres: ['movie_id', 'genre_id'],
  movie_tmdb: [
    'movie_id', 'tmdb_id', 'tmdb_title', 'tmdb_release_date', 'poster_path',
    'backdrop_path', 'overview', 'popularity', 'vote_average', 'enriched_at',
  ],
};

// Columns whose values are JSON arrays in SQLite but real arrays in the response.
const JSON_ARRAY_COLUMNS = { public_movies_api: ['genres'] };

const MAX_LIMIT = 1000; // matches the documented PostgREST cap

export class ApiError extends Error {
  constructor(status, message, hint) {
    super(message);
    this.status = status;
    this.hint = hint;
  }
}

export function isResource(name) {
  return Object.prototype.hasOwnProperty.call(RESOURCES, name);
}

export function jsonArrayColumns(resource) {
  return JSON_ARRAY_COLUMNS[resource] ?? [];
}

function assertColumn(resource, col) {
  if (!RESOURCES[resource].includes(col)) {
    throw new ApiError(400, `column "${col}" does not exist on "${resource}"`,
      `available: ${RESOURCES[resource].join(', ')}`);
  }
  return col;
}

// PostgREST wildcards are "*"; SQL LIKE wants "%". Callers that need
// case-sensitivity use GLOB, which already speaks "*".
const toLikePattern = (v) => v.replace(/%/g, '\\%').replace(/\*/g, '%');

// Splits "in.(a,b,c)" style lists, honouring double-quoted members so values
// containing commas survive.
function parseList(raw) {
  const inner = raw.replace(/^\(/, '').replace(/\)$/, '');
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"') { quoted = !quoted; continue; }
    if (c === ',' && !quoted) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur !== '' || out.length) out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

// Numeric-looking values are bound as numbers so integer columns compare
// correctly in SQLite's dynamic typing.
const coerce = (v) => (v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v);

function buildCondition(resource, column, spec, params) {
  // Full-text search is exposed on `movies` as search_tsv=wfts(english).term,
  // backed by FTS5 rather than a tsvector.
  if (column === 'search_tsv') {
    if (resource !== 'movies') {
      throw new ApiError(400, 'search_tsv is only available on "movies"');
    }
    const m = spec.match(/^w?fts(?:\([^)]*\))?\.(.*)$/s);
    if (!m) throw new ApiError(400, `unsupported operator for search_tsv: "${spec}"`);
    params.push(websearchToFts5(m[1]));
    return { sql: 'movies.id IN (SELECT rowid FROM movies_fts WHERE movies_fts MATCH ?)', fts: true };
  }

  assertColumn(resource, column);
  const dot = spec.indexOf('.');
  if (dot === -1) throw new ApiError(400, `malformed filter for "${column}": "${spec}"`);
  let op = spec.slice(0, dot);
  const rawValue = spec.slice(dot + 1);
  const negated = op === 'not' ? (() => { throw new ApiError(400, '"not" is not supported'); })() : false;

  switch (op) {
    case 'eq':  params.push(coerce(rawValue)); return { sql: `"${column}" = ?` };
    case 'neq': params.push(coerce(rawValue)); return { sql: `"${column}" <> ?` };
    case 'gt':  params.push(coerce(rawValue)); return { sql: `"${column}" > ?` };
    case 'gte': params.push(coerce(rawValue)); return { sql: `"${column}" >= ?` };
    case 'lt':  params.push(coerce(rawValue)); return { sql: `"${column}" < ?` };
    case 'lte': params.push(coerce(rawValue)); return { sql: `"${column}" <= ?` };

    case 'is': {
      const v = rawValue.toLowerCase();
      if (v === 'null')  return { sql: `"${column}" IS NULL` };
      if (v === 'true')  return { sql: `"${column}" = 1` };
      if (v === 'false') return { sql: `"${column}" = 0` };
      throw new ApiError(400, `"is" expects null/true/false, got "${rawValue}"`);
    }

    case 'in': {
      const list = parseList(rawValue);
      if (!list.length) return { sql: '0 = 1' };
      list.forEach((v) => params.push(coerce(v)));
      return { sql: `"${column}" IN (${list.map(() => '?').join(',')})` };
    }

    // Case-insensitive (SQLite LIKE is ASCII-case-insensitive by default).
    case 'ilike':
      params.push(toLikePattern(rawValue));
      return { sql: `"${column}" LIKE ? ESCAPE '\\'` };

    // Case-sensitive: GLOB already uses "*" as its wildcard.
    case 'like':
      params.push(rawValue);
      return { sql: `"${column}" GLOB ?` };

    // Array containment, e.g. genres=cs.{Horror}. Only meaningful on the JSON
    // array columns; every requested value must be present.
    case 'cs': {
      if (!jsonArrayColumns(resource).includes(column)) {
        throw new ApiError(400, `"cs" is only supported on array columns (${jsonArrayColumns(resource).join(', ') || 'none'})`);
      }
      const values = parseList(rawValue.replace(/^\{/, '(').replace(/\}$/, ')'));
      if (!values.length) return { sql: '1 = 1' };
      const clauses = values.map((v) => {
        params.push(v);
        return `EXISTS (SELECT 1 FROM json_each("${resource}"."${column}") WHERE json_each.value = ?)`;
      });
      return { sql: '(' + clauses.join(' AND ') + ')' };
    }

    default:
      throw new ApiError(400, `unsupported operator "${op}"`,
        'supported: eq neq gt gte lt lte like ilike in is cs (and wfts on movies.search_tsv)');
  }
}

// PostgREST's websearch_to_tsquery accepts quoted phrases, -exclusions and "or".
// Map that onto FTS5's query syntax as closely as it goes.
function websearchToFts5(input) {
  const tokens = input.match(/"[^"]*"|\S+/g) ?? [];
  const parts = [];
  for (const tok of tokens) {
    if (/^".*"$/.test(tok)) { parts.push(tok); continue; }          // phrase
    if (tok.toLowerCase() === 'or') { parts.push('OR'); continue; }
    if (tok.startsWith('-') && tok.length > 1) {
      parts.push('NOT', quoteFts(tok.slice(1)));
      continue;
    }
    parts.push(quoteFts(tok));
  }
  // Bare terms default to AND in both dialects; FTS5 infers it.
  const q = parts.join(' ').trim();
  if (!q) throw new ApiError(400, 'empty full-text search query');
  return q;
}

// FTS5 treats a lot of punctuation as syntax; quoting makes user input literal.
const quoteFts = (t) => '"' + t.replace(/"/g, '""') + '"';

/**
 * Build the SELECT for a resource request.
 * Returns { sql, params, columns, limit, offset, wantCount, countSql, countParams }.
 */
export function buildSelect(resource, searchParams, range) {
  if (!isResource(resource)) {
    throw new ApiError(404, `unknown resource "${resource}"`,
      `available: ${Object.keys(RESOURCES).join(', ')}`);
  }

  // ---- select ----
  const rawSelect = searchParams.get('select');
  let columns;
  if (!rawSelect || rawSelect.trim() === '*') {
    columns = [...RESOURCES[resource]];
  } else {
    if (/[()]/.test(rawSelect)) {
      throw new ApiError(400, 'embedded resources are not supported',
        'request the related resource separately, or use public_movies_api which already includes genres');
    }
    columns = rawSelect.split(',').map((c) => {
      const name = c.trim().split(':').pop().trim(); // tolerate alias:col
      return assertColumn(resource, name);
    });
    if (!columns.length) columns = [...RESOURCES[resource]];
  }

  // ---- filters ----
  const params = [];
  const where = [];
  const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'and', 'or']);
  for (const [key, value] of searchParams.entries()) {
    if (RESERVED.has(key)) continue;
    const { sql } = buildCondition(resource, key, value, params);
    where.push(sql);
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

  // ---- order ----
  const rawOrder = searchParams.get('order');
  let orderSql = '';
  if (rawOrder) {
    const terms = rawOrder.split(',').map((t) => {
      const bits = t.trim().split('.');
      const col = assertColumn(resource, bits[0]);
      let dir = 'ASC', nulls = '';
      for (const b of bits.slice(1)) {
        const k = b.toLowerCase();
        if (k === 'asc' || k === 'desc') dir = k.toUpperCase();
        else if (k === 'nullsfirst') nulls = ' NULLS FIRST';
        else if (k === 'nullslast') nulls = ' NULLS LAST';
        else throw new ApiError(400, `unsupported order modifier "${b}"`);
      }
      return `"${col}" ${dir}${nulls}`;
    });
    orderSql = ' ORDER BY ' + terms.join(', ');
  }

  // ---- limit / offset (query string wins; Range header is the fallback) ----
  let limit = MAX_LIMIT;
  let offset = 0;
  if (searchParams.has('limit')) {
    const n = parseInt(searchParams.get('limit'), 10);
    if (Number.isNaN(n) || n < 0) throw new ApiError(400, 'limit must be a non-negative integer');
    limit = Math.min(n, MAX_LIMIT);
  }
  if (searchParams.has('offset')) {
    const n = parseInt(searchParams.get('offset'), 10);
    if (Number.isNaN(n) || n < 0) throw new ApiError(400, 'offset must be a non-negative integer');
    offset = n;
  }
  if (range && !searchParams.has('limit')) {
    limit = Math.min(range.end - range.start + 1, MAX_LIMIT);
    offset = range.start;
  }

  const cols = columns.map((c) => `"${c}"`).join(', ');
  const sql = `SELECT ${cols} FROM "${resource}"${whereSql}${orderSql} LIMIT ? OFFSET ?`;

  return {
    sql,
    params: [...params, limit, offset],
    columns,
    limit,
    offset,
    countSql: `SELECT COUNT(*) AS n FROM "${resource}"${whereSql}`,
    countParams: params,
  };
}

export { MAX_LIMIT, RESOURCES };
