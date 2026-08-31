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
