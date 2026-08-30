/**
 * READING A REQUEST'S PARAMETERS — a path segment, and a query string.
 *
 * In `util/` for the same reason `./dates.ts` is: neither knows anything about
 * award travel, and both would read the same in any application. What they do
 * know about is HTTP, and the point of both exports is to keep that knowledge
 * from spreading — `rowIdParam` so a handler validates before the database is
 * touched, `QueryReader` so a WHERE builder in `db/` never has to take a Hono
 * `Context`.
 *
 * ## rowIdParam
 *
 * One helper, one reason. Every handler that owns an `:id` used to write
 * `Number(c.req.param("id"))` and bind the result straight into SQL, which for
 * `/api/tracked-routes/abc` binds `NaN`. D1 compares that against nothing, so
 * the handler did not fail — it succeeded emptily: PATCH and the search
 * endpoints answered `404 not_found` (right answer, wrong reason), and DELETE
 * answered `{ ok: true }` for a row that never existed, which is a lie told with
 * a 200.
 *
 * A malformed id is a malformed REQUEST, so it is a 400 and it is decided before
 * the database is touched.
 */

/**
 * How a handler hands a query string to something that must not know about HTTP.
 *
 * The WHERE builders in `db/` are shaped by the request's query string, and they
 * take one of these rather than a Hono `Context` — which is what keeps `db/`
 * free of the web framework while the handler stays free of SQL. Declared once
 * here because two db modules take one; it used to be declared identically in
 * both.
 */
export type QueryReader = (k: string) => string | undefined;

/**
 * A row id from a path segment, or `null` when the segment is not one.
 *
 * `Number.isInteger` rather than `!Number.isNaN`, and the difference is the
 * point: `Number("1.5")` and `Number("1e3")` are both perfectly good numbers and
 * neither is a rowid. `Number("")` is `0`, which is why an empty segment has to
 * fall out too — hence the explicit emptiness check rather than trusting the
 * coercion. Non-positive ids are refused for the same reason: SQLite rowids
 * start at 1, so `0` and `-1` are not "not found", they are not asked.
 */
export function rowIdParam(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
