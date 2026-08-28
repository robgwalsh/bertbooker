import { describe, expect, it } from "vitest";
import type { Segment } from "../api";
import { AIRLINE_ICAO } from "../data/airlineIcao";
import { carrierMarks, flightAwareUrl, flightLabel } from "./flights";

const seg = (carrier: string, flightNumber?: string): Segment => ({
  from: "SEA",
  to: "LAX",
  carrier,
  flightNumber,
});

describe("flightLabel", () => {
  it("joins carrier and bare number", () => {
    expect(flightLabel(seg("AS", "505"))).toBe("AS 505");
  });

  it("strips a carrier the source already prefixed", () => {
    expect(flightLabel(seg("AA", "AA4457"))).toBe("AA 4457");
  });

  it("degrades to whichever half exists", () => {
    expect(flightLabel(seg("DL"))).toBe("DL");
    expect(flightLabel(seg("", "505"))).toBe("505");
  });
});

describe("flightAwareUrl", () => {
  // FlightAware files Delta under DAL, and a URL built from the IATA ident is
  // not a page.
  it("translates IATA to the ICAO ident FlightAware canonicalizes on", () => {
    expect(flightAwareUrl(seg("DL", "5678"))).toBe(
      "https://www.flightaware.com/live/flight/DAL5678",
    );
    expect(flightAwareUrl(seg("AS", "505"))).toBe("https://www.flightaware.com/live/flight/ASA505");
  });

  it("translates after stripping a doubled carrier prefix", () => {
    expect(flightAwareUrl(seg("AA", "AA4457"))).toBe(
      "https://www.flightaware.com/live/flight/AAL4457",
    );
  });

  it("passes an unmapped carrier through unchanged", () => {
    expect(flightAwareUrl(seg("XX", "123"))).toBe("https://www.flightaware.com/live/flight/XX123");
  });

  it("needs both halves", () => {
    expect(flightAwareUrl(seg("DL"))).toBeUndefined();
    expect(flightAwareUrl(seg("", "5678"))).toBeUndefined();
    expect(flightAwareUrl(seg("DL", "not-a-number"))).toBeUndefined();
  });
});

describe("AIRLINE_ICAO", () => {
  it("maps two-character IATA codes to three-letter ICAO codes", () => {
    for (const [iata, icao] of Object.entries(AIRLINE_ICAO)) {
      expect(iata, `${iata} is not an IATA carrier code`).toMatch(/^[A-Z0-9]{2}$/);
      expect(icao, `${iata} -> ${icao} is not an ICAO carrier code`).toMatch(/^[A-Z]{3}$/);
    }
  });

  it("has no duplicate ICAO codes", () => {
    const icaos = Object.values(AIRLINE_ICAO);
    expect(new Set(icaos).size).toBe(icaos.length);
  });
});

describe("carrierMarks", () => {
  it("puts nonstop operators first and marks them", () => {
    const marks = carrierMarks('["AS","CX","JL","JX","PR"]', '["JL"]');
    expect(marks.map((m) => m.code)).toEqual(["JL", "AS", "CX", "JX", "PR"]);
    expect(marks.filter((m) => m.nonstop).map((m) => m.code)).toEqual(["JL"]);
  });

  // The two blobs are reported separately and neither is derived from the
  // other, so a code seen only in the nonstop list still has to get a mark.
  it("unions the two lists rather than filtering one by the other", () => {
    const marks = carrierMarks('["AS"]', '["JL"]');
    expect(marks).toEqual([
      { code: "JL", nonstop: true },
      { code: "AS", nonstop: false },
    ]);
  });

  it("omits carriers the caller already shows", () => {
    const marks = carrierMarks('["AS","CX","JL"]', '["JL"]', ["JL", "AS"]);
    expect(marks).toEqual([{ code: "CX", nonstop: false }]);
  });

  it("returns nothing for absent, empty or malformed blobs", () => {
    expect(carrierMarks(null, null)).toEqual([]);
    expect(carrierMarks(undefined, undefined)).toEqual([]);
    expect(carrierMarks("[]", "[]")).toEqual([]);
    expect(carrierMarks("not json", '["JL"')).toEqual([]);
  });

  // A blob is whatever the column holds; a number in the array must not become
  // a mark that asks the logo CDN for `/airlines/64x64/7.png`.
  it("drops non-string members", () => {
    expect(carrierMarks('["AS",7,null]', null)).toEqual([{ code: "AS", nonstop: false }]);
  });
});
