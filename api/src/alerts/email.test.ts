import { describe, expect, it } from "vitest";
import { allowedRecipients, isRecipientAllowed } from "./email.js";
import type { Env } from "../bindings.js";

// The allowlist is what stops one shared password turning this Worker into an
// arbitrary-recipient sender on a verified domain, so what is pinned here is the
// handful of properties that make it safe rather than merely present.

const env = (appUserEmail: string | undefined, rows: string[]): Env =>
  ({
    APP_USER_EMAIL: appUserEmail,
    DB: {
      prepare: () => ({
        all: async () => ({ results: rows.map((email) => ({ email })) }),
      }),
    },
  }) as unknown as Env;

describe("allowedRecipients", () => {
  it("puts the account address first, always", async () => {
    // It is the address a NULL `alert_email` resolves to, so it is the answer to
    // "who gets this by default" — and the System tab and the route form both
    // render in this order.
    expect(await allowedRecipients(env("me@x.com", ["b@x.com", "a@x.com"]))).toEqual([
      "me@x.com",
      "b@x.com",
      "a@x.com",
    ]);
  });

  it("allows the account address with an EMPTY table", async () => {
    // The property that keeps an empty list meaning "only the account's own
    // address" — the safe default — rather than "this deployment can email
    // nobody", which is what reading the table as the whole list would give.
    expect(await allowedRecipients(env("me@x.com", []))).toEqual(["me@x.com"]);
    expect(await isRecipientAllowed(env("me@x.com", []), "me@x.com")).toBe(true);
  });

  it("never lists the account address twice", async () => {
    // The API refuses to add it, but a database edited by hand is not bound by
    // that, and a duplicate would render twice in the System tab.
    expect(await allowedRecipients(env("me@x.com", ["me@x.com"]))).toEqual(["me@x.com"]);
  });

  it("allows nothing at all when APP_USER_EMAIL is unset", async () => {
    // Fail-closed, matching the cron: with no identity there is no account to
    // attribute a sweep to, and no default recipient either.
    expect(await allowedRecipients(env(undefined, []))).toEqual([]);
  });
});

describe("isRecipientAllowed", () => {
  it("matches case-insensitively, on both sides", async () => {
    // The table is normalised on write, but `alert_email` predates that and a
    // stored "A@X.com" must still resolve. Comparing raw would refuse an address
    // that IS on the list.
    const e = env("Me@X.com", ["A@X.com"]);
    expect(await isRecipientAllowed(e, "a@x.com")).toBe(true);
    expect(await isRecipientAllowed(e, "  ME@x.COM  ")).toBe(true);
  });

  it("refuses an address that is not on the list", async () => {
    expect(await isRecipientAllowed(env("me@x.com", ["a@x.com"]), "you@x.com")).toBe(false);
  });
});
