# Security

## Reporting a vulnerability

Please **do not open a public issue.**

Use GitHub's private vulnerability reporting instead:
[**Report a vulnerability**](https://github.com/robgwalsh/bertbooker/security/advisories/new).

This is a personal project maintained in spare time. Expect a reply within a
week or so, and no formal SLA beyond that.

## Scope

This is self-hosted software with **no hosted service and no shared
infrastructure** — every instance is somebody's own Cloudflare account, with
their own keys and their own database. A report is therefore about the code, not
about an environment I control.

Worth a report:

- Anything that lets a request past the password gate (`workers/api/src/gate.ts`)
  or forges a session cookie.
- Anything that lets `/api/ingest/*` be written to without a valid
  `INGEST_TOKEN`.
- SQL injection, XSS, or a way to read another deployment's data.
- A secret being logged, echoed in a response, or written somewhere tracked.

## Known and accepted by design

These are documented decisions rather than oversights, and a report on them will
be closed as such:

- **One shared password, one shared identity.** There are no per-user accounts.
  Everyone who knows the password is the same account and sees the same data.
  `APP_USER_EMAIL` is that identity; it is not an authentication factor.
- **`Cf-Access-Authenticated-User-Email` is deliberately ignored.** With no
  Cloudflare Access in front of the Worker and no JWT verification, that header
  is a string the client picked. Trusting it would be the bug.
- **The app is only as private as its password.** There is no rate limiting on
  the login endpoint by default; a weak `APP_PASSWORD` is the realistic risk to
  any deployment, which is why an unset one fails closed with a 503 rather than
  serving.

## If you are deploying this

- Use a strong, unique `APP_PASSWORD`, and a `SESSION_SECRET` of 32 random bytes
  that is *not* derived from it. Rotating `APP_PASSWORD` invalidates every live
  session, by design.
- Keep `.dev.vars` and `.env` out of version control. They are gitignored; the
  tracked files are the `.example` templates.
- Production secrets belong in `wrangler secret put`, never in `wrangler.toml` —
  that file is public in this repo and in any fork of it.
