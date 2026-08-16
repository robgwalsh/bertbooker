import { PROGRAM_SEEDS } from "../domain/programs.js";
import type { ChangeSummary } from "../domain/diff.js";

/**
 * The alert email, as strings.
 *
 * Pure, and it is the whole of what the tests assert on — the Worker half only
 * has to hand these to Resend. Everything here is display; nothing decides what
 * gets sent (`selectAlertable`) or when (`pace.ts`).
 *
 * **This app sends no failure emails.** A sweep that was blocked, refused, or
 * skipped for budget is visible in the Alerts tab and nowhere else, which is a
 * deliberate choice and the reason the tab exists. So a digest that exists at
 * all is about finds — and it says which routes were swept and found nothing,
 * by name, because "three routes checked, two quiet" and "only one route ran"
 * are different facts and a digest listing only the noisy route cannot tell them
 * apart.
 */

/** A route's worth of changes, ready to render. */
export interface DigestGroup {
  routeId: number;
  /** `SEA/PDX → NRT/HND`, drawn by the caller from the route's airport sets. */
  label: string;
  changes: ChangeSummary[];
}

export interface DigestInput {
  groups: DigestGroup[];
  /** Routes that were swept and had nothing to report. Named, not omitted. */
  quiet: string[];
  /** Absolute base for links back into the app, e.g. `https://points.…`. */
  appUrl?: string;
}

export interface RenderedDigest {
  subject: string;
  html: string;
  text: string;
}

const PROGRAM_NAMES = new Map(PROGRAM_SEEDS.map((p) => [p.code, p.name] as const));

/** Escape for HTML text and attribute contexts.
 *
 *  Airport codes, program codes and cabins all come out of the database, and
 *  the database is filled by parsing other people's payloads. HTML-injecting
 *  your own inbox is still a bug, and this is one line. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const fmtMiles = (n: number | undefined): string =>
  n == null ? "—" : `${Math.round(n).toLocaleString("en-US")}`;

/** One change as a sentence, without markup — shared by both renderings so they
 *  cannot describe the same event differently. */
export function describeChange(c: ChangeSummary): string {
  const where = c.origin && c.destination ? `${c.origin}→${c.destination}` : "";
  const what = [where, c.flightDate, PROGRAM_NAMES.get(c.program) ?? c.program, c.cabin]
    .filter(Boolean)
    .join(" · ");

  switch (c.type) {
    case "new":
      return `${what} — ${fmtMiles(c.milesCost)} miles, ${c.seatsAvailable ?? "?"} seat${
        c.seatsAvailable === 1 ? "" : "s"
      }`;
    case "price_drop":
      return `${what} — ${fmtMiles(c.previousMilesCost)} → ${fmtMiles(c.milesCost)} miles`;
    case "more_seats":
      // Named for what actually changed, but the price is carried too: the
      // classifier is first-match-wins, so a drop that coincided with a seat
      // increase arrives here and would otherwise go unmentioned.
      return `${what} — ${c.previousSeats ?? "?"} → ${c.seatsAvailable ?? "?"} seats${
        c.previousMilesCost != null && c.milesCost != null && c.milesCost < c.previousMilesCost
          ? `, and ${fmtMiles(c.previousMilesCost)} → ${fmtMiles(c.milesCost)} miles`
          : ""
      }`;
    case "gone":
      return `${what} — gone (was ${fmtMiles(c.previousMilesCost)} miles)`;
  }
}

const TYPE_LABEL: Record<ChangeSummary["type"], string> = {
  new: "New",
  price_drop: "Cheaper",
  more_seats: "More seats",
  gone: "Gone",
};

/** A route as the grouper needs it: who to tell, what to call it, and whether it
 *  had anything to say. */
export interface DigestRoute {
  routeId: number;
  label: string;
  /** Already resolved — `alert_email` or the account's own address. */
  recipient: string;
  changes: ChangeSummary[];
}

/**
 * One digest per recipient, not per route.
 *
 * A person watching three routes gets one email with three sections; two people
 * watching overlapping routes each get their own. Routes with nothing to report
 * become the `quiet` list rather than vanishing — see the note at the top of
 * this file for why that distinction is the whole point.
 *
 * A recipient whose routes were ALL quiet gets nothing: there is no news, and
 * this app deliberately does not send "still working" mail.
 */
export function groupForRecipients(
  routes: DigestRoute[],
  appUrl?: string,
): Map<string, DigestInput> {
  const out = new Map<string, DigestInput>();
  for (const r of routes) {
    let bucket = out.get(r.recipient);
    if (!bucket) {
      bucket = { groups: [], quiet: [], appUrl };
      out.set(r.recipient, bucket);
    }
    if (r.changes.length) {
      bucket.groups.push({ routeId: r.routeId, label: r.label, changes: r.changes });
    } else {
      bucket.quiet.push(r.label);
    }
  }
  for (const [recipient, bucket] of out) {
    if (bucket.groups.length === 0) out.delete(recipient);
  }
  return out;
}

export function digestSubject(input: DigestInput): string {
  const total = input.groups.reduce((n, g) => n + g.changes.length, 0);
  if (total === 0) return "BertBooker — nothing new";
  const routes = input.groups.length;
  const noun = total === 1 ? "change" : "changes";
  // The route's name in the subject when there is only one, because that is the
  // line you read in a notification without opening anything.
  if (routes === 1) return `BertBooker — ${total} ${noun} on ${input.groups[0]!.label}`;
  return `BertBooker — ${total} ${noun} across ${routes} routes`;
}

export function renderDigest(input: DigestInput): RenderedDigest {
  const subject = digestSubject(input);

  const textParts: string[] = [];
  const htmlParts: string[] = [];

  for (const g of input.groups) {
    textParts.push(`${g.label}`);
    htmlParts.push(
      `<h2 style="font:600 15px system-ui,sans-serif;margin:24px 0 8px">${escapeHtml(g.label)}</h2>`,
    );
    const rows: string[] = [];
    for (const c of g.changes) {
      textParts.push(`  [${TYPE_LABEL[c.type]}] ${describeChange(c)}`);
      rows.push(
        `<tr><td style="padding:4px 10px 4px 0;font:600 12px system-ui,sans-serif;white-space:nowrap">${escapeHtml(
          TYPE_LABEL[c.type],
        )}</td><td style="padding:4px 0;font:13px system-ui,sans-serif">${escapeHtml(
          describeChange(c),
        )}</td></tr>`,
      );
    }
    htmlParts.push(`<table style="border-collapse:collapse">${rows.join("")}</table>`);
    textParts.push("");
  }

  if (input.quiet.length) {
    const line = `Also checked, nothing new: ${input.quiet.join(", ")}`;
    textParts.push(line);
    htmlParts.push(
      `<p style="font:13px system-ui,sans-serif;color:#666;margin-top:24px">${escapeHtml(line)}</p>`,
    );
  }

  if (input.appUrl) {
    const url = escapeHtml(input.appUrl);
    textParts.push("", input.appUrl);
    htmlParts.push(
      `<p style="font:13px system-ui,sans-serif;margin-top:16px"><a href="${url}">Open BertBooker</a></p>`,
    );
  }

  return {
    subject,
    text: textParts.join("\n").trim(),
    html: `<div style="max-width:640px">${htmlParts.join("\n")}</div>`,
  };
}
