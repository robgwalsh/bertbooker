import {
  POINTSYEAH_HORIZON_DAYS,
  POINTSYEAH_PROGRAM_MAP,
  POINTSYEAH_SOURCE_ID,
  PointsYeahProvider,
  type PointsYeahOptions,
} from "../providers/pointsyeah.js";
import { effectiveSearchWindow } from "../providers/window.js";
import { datesIn } from "../providers/seatsaero.js";
import type { RunnableSource, SourceCtx, SourceQuery, SourceResult, SourceTask } from "./types.js";

/** Every program PointsYeah can produce, deduped from its IATA map. It is the
 *  only source this app has for `cathay` and `eva` — seats.aero carries no
 *  source for either under any spelling tried. */
export const POINTSYEAH_PROGRAMS = [...new Set(Object.values(POINTSYEAH_PROGRAM_MAP))];

/**
 * PointsYeah as a plug-in source.
 *
 * **One task per run, deliberately.** PointsYeah's fan-out is genuinely internal
 * — it tiles its own date sub-windows, clamps to its own ~70-day horizon and
 * enriches each kept result from a detail URL, all inside `search()`. Splitting
 * that into observable tasks would mean rewriting it for metadata nothing needs.
 *
 * The trade is stated plainly: one task means one status for the whole source.
 * "6 of 6 sub-windows returned" and "1 of 6 returned" both read as `ok`. That is
 * acceptable for an aggregator that either answers or doesn't; it would not be
 * acceptable for a source that can be refused per request, which is why the
 * contract supports many tasks even though this source uses one.
 *
 * `runtime: "local"` records a measurement we have NOT made: PointsYeah is an
 * anonymous JSON API and might well answer a Worker, but it has only ever been
 * called from a residential connection and nothing here has tested otherwise.
 * Promoting it to `worker` is a one-line change once somebody probes it from the
 * edge — and a bad idea until they do, because a source that quietly returns
 * nothing is indistinguishable from a route with no award space.
 */
export function pointsYeahSource(opts: PointsYeahOptions = {}): RunnableSource {
  const provider = new PointsYeahProvider(opts);

  return {
    id: POINTSYEAH_SOURCE_ID,
    label: "PointsYeah",
    programs: POINTSYEAH_PROGRAMS,
    horizonDays: POINTSYEAH_HORIZON_DAYS,
    runtime: "local",

    supports(q: SourceQuery): boolean {
      if (!q.programs?.length) return true;
      return q.programs.some((p) => POINTSYEAH_PROGRAMS.includes(p));
    },

    plan(q: SourceQuery, today: string): SourceTask[] {
      // Pure, and clamped to the live horizon here rather than inside `run` so
      // that a window entirely beyond it plans ZERO tasks — which reads as
      // "nothing to do", not as a source that ran and found nothing. The
      // difference matters: the second would claim coverage.
      const win = effectiveSearchWindow(q.dateStart, q.dateEnd, today, POINTSYEAH_HORIZON_DAYS);
      if (!win) return [];
      return [
        {
          key: `${POINTSYEAH_SOURCE_ID}:${q.origin}-${q.destination}:${win.start}..${win.end}`,
          source: POINTSYEAH_SOURCE_ID,
          origin: q.origin,
          destination: q.destination,
          dates: datesIn(win.start, win.end),
          programs: POINTSYEAH_PROGRAMS,
          payload: win,
        },
      ];
    },

    async run(task: SourceTask, ctx: SourceCtx): Promise<SourceResult> {
      const win = task.payload as { start: string; end: string };
      const offers = await provider.search(
        {
          origin: task.origin,
          destination: task.destination,
          dateStart: win.start,
          dateEnd: win.end,
          // Gather wide, query narrow: no cabin, currency or seat filter here.
          minSeats: 1,
          kind: "flight",
        },
        ctx,
      );
      return {
        offers,
        // Re-clamp to the planned window. The source is trusted to stay inside
        // it, but a stray date would widen the coverage claim through the
        // returned-offers fold-in — the one direction that deletes data.
        coveredDates: task.dates,
      };
    },
  };
}
