import { describe, expect, it } from "vitest";
import type { Find } from "../../api";
import type { RoundTripPair } from "../../lib/roundtrip";
import {
  DEFAULT_SORT,
  sortFinds,
  sortPairs,
  toggleSort,
  type FindSortKey,
  type SortState,
} from "./findSort";

function find(p: Partial<Find> & Pick<Find, "flight_date">): Find {
  return {
    origin: "SEA",
    destination: "HND",
    program: "alaska",
    cabin: "business",
    seats_available: 2,
    miles_cost: 60_000,
    cash_fees_cents: 560,
    is_direct: 1,
    source: "seatsaero",
    source_fetched_at: 1_760_000_000_000,
    ...p,
  };
}

function pair(p: Partial<RoundTripPair> & { out: string; back: string }): RoundTripPair {
  return {
    outbound: find({ flight_date: p.out }),
    inbound: find({ flight_date: p.back, origin: "HND", destination: "SEA" }),
    nights: 7,
    cabin: "business",
    totalMiles: 120_000,
    totalFeesCents: 1_120,
    seats: 2,
    ...p,
  };
}

const dates = (finds: Find[]) => finds.map((f) => f.flight_date);
const asc = (key: FindSortKey): SortState<FindSortKey> => ({ key, dir: "asc" });
const desc = (key: FindSortKey): SortState<FindSortKey> => ({ key, dir: "desc" });

describe("toggleSort", () => {
  it("starts a new column ascending", () => {
    expect(toggleSort(asc("date"), "cost")).toEqual({ key: "cost", dir: "asc" });
    expect(toggleSort(desc("date"), "cost")).toEqual({ key: "cost", dir: "asc" });
  });

  it("flips the active column both ways", () => {
    expect(toggleSort(asc("cost"), "cost")).toEqual({ key: "cost", dir: "desc" });
    expect(toggleSort(desc("cost"), "cost")).toEqual({ key: "cost", dir: "asc" });
  });

  it("defaults to date ascending", () => {
    expect(DEFAULT_SORT).toEqual({ key: "date", dir: "asc" });
  });
});

describe("sortFinds", () => {
  const rows = [
    find({ flight_date: "2027-03-09", miles_cost: 30_000, seats_available: 1 }),
    find({ flight_date: "2027-03-02", miles_cost: 90_000, seats_available: 5 }),
    find({ flight_date: "2027-03-20", miles_cost: 60_000, seats_available: 3 }),
  ];

  it("orders by date both ways", () => {
    expect(dates(sortFinds(rows, asc("date")))).toEqual([
      "2027-03-02",
      "2027-03-09",
      "2027-03-20",
    ]);
    expect(dates(sortFinds(rows, desc("date")))).toEqual([
      "2027-03-20",
      "2027-03-09",
      "2027-03-02",
    ]);
  });

  it("orders by the figure the Cost cell leads with", () => {
    expect(sortFinds(rows, asc("cost")).map((f) => f.miles_cost)).toEqual([
      30_000, 60_000, 90_000,
    ]);
  });

  it("orders cabins up the ladder, not alphabetically", () => {
    const cabins = ["business", "economy", "first", "premium"].map((cabin) =>
      find({ flight_date: "2027-03-01", cabin }),
    );
    expect(sortFinds(cabins, asc("cabin")).map((f) => f.cabin)).toEqual([
      "economy",
      "premium",
      "business",
      "first",
    ]);
  });

  it("sorts an unknown cabin after every known one", () => {
    const cabins = [
      find({ flight_date: "2027-03-01", cabin: "sleeper" }),
      find({ flight_date: "2027-03-01", cabin: "first" }),
    ];
    expect(sortFinds(cabins, asc("cabin")).map((f) => f.cabin)).toEqual(["first", "sleeper"]);
  });

  it("breaks ties on date, ascending, whichever way the column points", () => {
    const tied = [
      find({ flight_date: "2027-03-20", miles_cost: 60_000 }),
      find({ flight_date: "2027-03-02", miles_cost: 60_000 }),
    ];
    expect(dates(sortFinds(tied, asc("cost")))).toEqual(["2027-03-02", "2027-03-20"]);
    expect(dates(sortFinds(tied, desc("cost")))).toEqual(["2027-03-02", "2027-03-20"]);
  });

  it("leaves its input alone", () => {
    const input = [...rows];
    sortFinds(input, desc("cost"));
    expect(input).toEqual(rows);
  });
});

describe("sortPairs", () => {
  it("orders trips by their outbound date, then their return", () => {
    const pairs = [
      pair({ out: "2027-03-09", back: "2027-03-16" }),
      pair({ out: "2027-03-02", back: "2027-03-20" }),
      pair({ out: "2027-03-02", back: "2027-03-09" }),
    ];
    expect(
      sortPairs(pairs, { key: "date", dir: "asc" }).map(
        (p) => `${p.outbound.flight_date}/${p.inbound.flight_date}`,
      ),
    ).toEqual(["2027-03-02/2027-03-09", "2027-03-02/2027-03-20", "2027-03-09/2027-03-16"]);
  });

  it("orders by the pair's total, not by one leg", () => {
    const pairs = [
      pair({ out: "2027-03-01", back: "2027-03-08", totalMiles: 200_000 }),
      pair({ out: "2027-03-02", back: "2027-03-09", totalMiles: 100_000 }),
    ];
    expect(sortPairs(pairs, { key: "cost", dir: "asc" }).map((p) => p.totalMiles)).toEqual([
      100_000, 200_000,
    ]);
  });

  it("sorts nights, which the one-way table has no column for", () => {
    const pairs = [
      pair({ out: "2027-03-01", back: "2027-03-15", nights: 14 }),
      pair({ out: "2027-03-02", back: "2027-03-05", nights: 3 }),
    ];
    expect(sortPairs(pairs, { key: "nights", dir: "desc" }).map((p) => p.nights)).toEqual([
      14, 3,
    ]);
  });

  it("orders by the outbound's program, then the return's", () => {
    const pairs = [
      pair({ out: "2027-03-01", back: "2027-03-08" }),
      pair({ out: "2027-03-01", back: "2027-03-08" }),
    ];
    pairs[0]!.outbound = find({ flight_date: "2027-03-01", program: "virginatlantic" });
    pairs[1]!.outbound = find({ flight_date: "2027-03-01", program: "aeroplan" });
    expect(
      sortPairs(pairs, { key: "program", dir: "asc" }).map((p) => p.outbound.program),
    ).toEqual(["aeroplan", "virginatlantic"]);
  });
});
