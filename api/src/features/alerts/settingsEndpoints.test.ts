import { describe, expect, it } from "vitest";
import { isEmailAddress, normalizeEmail } from "./settingsEndpoints.js";

// Only the two pure halves of the endpoint are reachable here; the Hono handlers
// around them hold no logic worth testing, matching the rest of the repo.

describe("normalizeEmail", () => {
  it("trims and lower-cases, which is what makes UNIQUE a real guarantee", () => {
    // Every write goes through this before it reaches the table, so `A@X.com`
    // and `a@x.com` cannot both be stored — and the duplicate check, the
    // in-use check and `isRecipientAllowed` all compare in this form.
    expect(normalizeEmail("  A@X.com ")).toBe("a@x.com");
  });
});

describe("isEmailAddress", () => {
  it("accepts an ordinary address", () => {
    expect(isEmailAddress("a@x.com")).toBe(true);
    expect(isEmailAddress("first.last+tag@mail.example.co.uk")).toBe(true);
  });

  it("refuses the typos this exists to catch", () => {
    // A leftover separator from the CSV binding this replaced, a pasted display
    // name, a missing @ or TLD. Each one reaches Resend if it gets through.
    expect(isEmailAddress("")).toBe(false);
    expect(isEmailAddress("a@x.com,b@x.com")).toBe(false);
    expect(isEmailAddress("Rob <rob@x.com>")).toBe(false);
    expect(isEmailAddress("rob@x.com rob@y.com")).toBe(false);
    expect(isEmailAddress("nobody")).toBe(false);
    expect(isEmailAddress("nobody@localhost")).toBe(false);
    expect(isEmailAddress("@x.com")).toBe(false);
    expect(isEmailAddress("a@.com")).toBe(false);
  });

  it("refuses an address longer than any mail system carries", () => {
    expect(isEmailAddress(`${"a".repeat(250)}@x.com`)).toBe(false);
  });
});
