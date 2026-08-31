/**
 * A STORED FIND — the shapes the `finds` table is read back in, and the shape of
 * the predicate that bounds those reads.
 *
 * `finds` holds one row per (origin, destination, flight_date, program, cabin),
 * so a find IS a row. What varies is the PROJECTION: the Routes page draws a
 * find, ingest diffs against one, the sweep only needs a membership set, and
 * enrichment needs the price and the hash. Each projection has its own type
 * here, and the statement that produces it is in `db/finds.ts` — a type here and
 * a SELECT there must be edited together, which is why each names the other.
 *
 * The row the SPA renders is `Find`, and it is a WIRE type
 * (`api/src/models/wire/rows.ts`). Nothing in this file is rendered.
 */

/**
 * A predicate narrowing which rows a read returns.
 *
 * **A scope may constrain any column `routeMatcher` reads, exactly as hard as
 * the matcher constrains it and never harder.** That is the whole contract, and
 * the only way to break it is to push a filter down that the matcher does not
 * apply — which drops finds silently, out of the Routes page and out of digests,
 * which send no mail when they find nothing and so cannot tell you.
 * `routeFindsScope` in `db/finds.ts` is what builds one, and `finds.test.ts`
 * proves the claim.
 *
 * Column names go in UNQUALIFIED; the text is interpolated once into a plain
 * SELECT over the bare table.
 */
export interface FindsScope {
  where: string[];
  binds: unknown[];
}

/** One `finds` row that could be enriched. Produced by `selectEnrichableRows`. */
export interface EnrichableRow {
  origin: string;
  destination: string;
  flight_date: string;
  program: string;
  cabin: string;
  miles_cost: number;
  source_record_id: string | null;
  detail_level: string;
  /** The stored hash of the SOURCE's claim, carried so the enrichment writes can
   *  check the row still holds the price the itinerary was chosen against. */
  raw_hash: string;
}

/** One availability id a bulk enrich would spend a call on. Produced by
 *  `selectEnrichTargets`, which is where the rule for what qualifies lives. */
export interface EnrichTargetRow {
  origin: string;
  destination: string;
  flight_date: string;
  program: string;
  source_record_id: string;
}
