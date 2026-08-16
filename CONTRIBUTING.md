# Contributing

Thanks for looking. Two things worth saying before you spend time.

**This is a personal project, shared because it may be useful rather than
because it is a product.** It is built around one household's cards and habits,
and it is not seeking feature parity with anything. Large or architectural PRs
are likely to be declined — not because they are bad, but because maintaining
them is a commitment this repo does not make. **Open an issue before writing
anything substantial**, so neither of us wastes an afternoon.

**Forking is a first-class option.** MIT, no strings. If you want a version that
works differently, a fork you control is a better outcome than a compromise
neither of us likes.

## What is genuinely welcome

- **Bug reports**, especially with a failing test.
- **A broken source.** These integrations sit on other people's services and
  break without notice; a re-captured fixture and a fixed parser is the single
  most useful PR this repo can get.
- **A new source.** This is the one extension point that is actually *designed*
  for it — read [`docs/SOURCES.md`](docs/SOURCES.md), which is the plug-in
  contract in full.
- **Documentation fixes**, including anywhere the setup path does not work on a
  clean machine.

## Before you open a PR

```sh
npm install
npm run typecheck
npm test          # offline and hermetic — no servers, no network, no browser
```

CI runs exactly those two. If you touched the SPA and have Chrome installed,
`npm run test:ui` is the browser suite; read
[`docs/UI-TESTING.md`](docs/UI-TESTING.md) first, and never pass `--headed`,
`--ui` or `--debug` (all open a window).

**Never let a test or a script press Search, fire `/__scheduled`, or run
`npm run probe:*`.** All three spend a metered, paid seats.aero quota against a
real key.

## House rules

The repo is heavily commented, and that is deliberate: comments here explain
*why* a thing is the way it is, usually because the obvious alternative was tried
and failed. Match that. If you change something a comment defends, change the
comment in the same commit — and if the comment turns out to be wrong, say so.

Some specifics that are easy to trip over:

- **Read [`CLAUDE.md`](CLAUDE.md)** — it is the invariants in short form, and it
  is written for anyone working here, not only for the tool it is named after.
- **Never write a parser against a guessed payload.** Capture a real one.
  Fixtures are committed forever, redacted and trimmed — read one before you
  commit it, and make sure it carries no credential or personal itinerary.
- **Coverage is a stored fact, and over-claiming deletes real data.** If you
  touch anything under `shared/src/ingest`, the rules in
  [`docs/SOURCES.md`](docs/SOURCES.md) are load-bearing rather than stylistic.
- **The Worker never calls an airline's own site.** See
  [`docs/HARVEST-POSTMORTEM.md`](docs/HARVEST-POSTMORTEM.md) before proposing a
  source that does — the reason is product policy, not anti-bot, and it has
  already been paid for once.
- **Do not commit secrets.** There is one secrets file, `api/.dev.vars`, and it
  is gitignored; the tracked template beside it is `api/.dev.vars.example`.

## Security

Please do not open a public issue for a security problem — see
[SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
