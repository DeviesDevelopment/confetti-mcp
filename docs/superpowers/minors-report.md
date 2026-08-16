# Minors backlog — clearing report

All 7 deferred minors from `docs/follow-ups.md` are done. `npm test` (321
passing, pristine — no warnings), `npm run lint`, and `npm run build` are all
clean; working tree is clean.

## Commits (6, on `main`)

1. `bdbc35c` — freeze `ID_SCHEMA`/`PAGE_SCHEMA` (deep-frozen), TDD: test
   written and confirmed failing before the fix.
2. `ae0c8bb` — `annotate()` converted to the same exhaustive-switch shape as
   `schemaFor`/`describe`. Verified by temporarily adding a bogus `Operation`
   member and confirming `annotate()` now fails to compile (TS2366) exactly
   like `schemaFor` already did; change reverted after confirming.
3. `9ab9e41` — added `ignoreRestSiblings: true` to eslint config; simplified
   `withoutId` to `const { id, ...rest } = args`.
4. `3606e8e` — one-line comment on the `req.params` double cast in `app.ts`.
5. `0c2b47e` — README: documented the `GET`/`DELETE /mcp` 405s, moved
   Self-hosting above the "Connect from..." sections.
6. `fea9cb2` — struck through all 7 items in `docs/follow-ups.md`.

## Item 3 (compact samples) — already done, no code change

`sampleOf()` (renamed from `sampleFor` at some point) already uses compact
`JSON.stringify(sample)` with no indentation, and the context-budget test's
accounting comment already reflects it. Checked git history: this was fixed
in commit `b1487f78` ("fix: publish schemas a model can satisfy..."),
**before** `docs/follow-ups.md` was written — the follow-ups entry was stale
from the start, not a regression. I struck it through with a note rather than
reworking anything.

Measured byte delta anyway, by temporarily reverting to pretty-print,
measuring, then reverting back (confirmed zero net diff via `git diff`):
- **Compact (current, shipped):** 73,361 bytes total tool surface / 6,353
  bytes in samples.
- **Pretty-printed (hypothetical):** 74,956 bytes / 7,632 bytes in samples.
- **Delta: 1,595 bytes total (−2.1%), 1,279 bytes in samples (−16.8%)** — a
  much smaller effect than the "~30%" estimate in the task, because that
  estimate was against the pre-dedup sample cost (12,524 bytes); today's
  samples are already deduplicated to one per resource, so indentation has
  less duplicated text to inflate.

## Item 4 choice

Went with the rest-destructuring idiom (`const { id, ...rest } = args`) over
keeping copy-then-delete. It reads as "everything except id" in one
expression rather than "copy, then remove id" as two steps, and it's the
idiom `ignoreRestSiblings` exists to unblock. All existing dispatch tests
pass unchanged (confirmed — `withoutId` isn't tested directly, only through
`callTool`/`update`).

## Item 5 correction

The task's proposed reasoning for the `req.params` cast ("safe because `/mcp`
has no path parameters") doesn't hold: `handleMcp` also serves
`/mcp/k/:apiKey`, which *does* have a path parameter, and `extractApiKey`
actually reads it (`req.params?.['apiKey']`) as an auth carrier. Verified the
correct reasoning instead: neither route declares a wildcard/splat segment
(`*name`), so every named param — including `:apiKey` — is always a single
string at runtime, never the `string[]` that Express 5's `ParamsDictionary`
type allows for (to account for wildcard matches). That's what the comment in
`app.ts` says, and it's what I struck through in `follow-ups.md` with the
correction noted.

## Not done

Nothing was skipped. Arm64/QEMU and the `ci.yml`/`release.yml` smoke-test
duplication were explicitly out of scope (release path, being considered
separately) and were not touched.
