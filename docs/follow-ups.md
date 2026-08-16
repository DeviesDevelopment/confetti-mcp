# Follow-ups and deferred work

Everything here was found by review or by real use, considered, and consciously
left undone. Each entry says why, so a future reader can disagree with the
reasoning rather than rediscover the problem.

Companion documents: [`audit-2026-08-15.md`](audit-2026-08-15.md) (29 defect
findings, 6 refuted) and
[`mcp-improvements-2026-08-15.md`](mcp-improvements-2026-08-15.md) (9 kept of 27).
Both are point-in-time records — this file is the living list.

## Blocked on upstream

Five issues are filed against `confetti/confetti-node`. Three sit in the same
~40 lines of `adapter.ts`, so whoever picks one up should look at all three.

| Issue | What it unblocks here |
| --- | --- |
| [#34](https://github.com/confetti/confetti-node/issues/34) — process-global record store leaks between requests | We route around it with a per-call store via `raw: true`. A fix upstream would protect every other consumer; ours is a workaround, not a cure. |
| [#35](https://github.com/confetti/confetti-node/issues/35) — `formValues` phantom in `ticket.values` | We override that description in `notes.ts`. The override can be deleted when upstream corrects it. |
| [#36](https://github.com/confetti/confetti-node/issues/36) — `schemaToJsonSchema` strips `helpText`/`values` | **Highest leverage.** Field description coverage is 61%; this is the single change that would move it furthest, for every consumer. It would also let us delete most of `FIELD_DESCRIPTIONS`. Do not hand-write more field docs before this resolves — that work would be thrown away. |
| [#37](https://github.com/confetti/confetti-node/issues/37) — array filters serialised as indexed keys | Fixed downstream in `commaJoinFilters`. That helper is deletable once upstream sets an `arrayFormat`. |
| [#38](https://github.com/confetti/confetti-node/issues/38) — no `meta.total` on list responses | Counting currently costs a full fetch: "which upcoming event has the most attending tickets?" took 42 calls to produce 42 integers. `shape.ts` already reads `meta.total`, so the day it appears we surface it with no code change. |

**Explicitly rejected:** building aggregate/count tools in this server. It would
break the generated-tools property (every tool tracks the registry; a hand-written
aggregate tracks nothing), turn one MCP call into N upstream calls — blowing the
25s deadline and making this server a load amplifier — and it works around a
missing field rather than fixing it. Revisit only if counting proves common in
real use, and prefer a response mode on the existing `find_all` tools over a new
tool family.

## Deferred defects and polish

None of these are on fire. The final review triaged them with whole-branch
context and left them deferred; that judgement still holds.

- ~~Tests leak a listening handle on failure~~ — **done.** Converted to
  `t.after(() => server.close())` across all four server test files and removed
  `--test-force-exit`. A failing test now exits 1 in ~3s with the failure
  reported, where it previously hung indefinitely.
- ~~The 500 error-handler path has no test~~ — **done.** No HTTP request can
  reach that branch (`extractApiKey` and `getToolSet` are total over their
  inputs, and everything else is classified as a client fault first), so the
  handler is exported as `errorHandler` and tested directly. An attempt via
  node's module mocking was reverted: it required
  `--experimental-test-module-mocks`, which printed an ExperimentalWarning on
  every run of all 319 tests to cover four lines, and staked the suite on an API
  Node says may change. A named export was the cheaper seam.
- ~~`ID_SCHEMA` and `PAGE_SCHEMA` are shared by reference across tools rather
  than cloned~~ — **done.** Both are now `Object.freeze`d (`PAGE_SCHEMA` deeply,
  since it nests `properties`), so accidental mutation throws instead of
  silently corrupting every tool that shares the object. A test pins that two
  tools' `id`/`page` schemas are the literal same object and that mutating
  either throws.
- ~~`annotate()` uses `===` comparisons rather than an exhaustive switch~~ —
  **done.** Converted to the same switch shape as `schemaFor`/`describe`.
  Verified by temporarily adding a bogus operation to the `Operation` union:
  `annotate()` now fails with the same TS2366 ("lacks ending return statement")
  that `schemaFor` already produced, where it previously compiled silently.
- ~~Sample records embed pretty-printed rather than compact~~ — **done**,
  already, as of the schema-and-descriptions fix earlier the same day
  (`b1487f78`): `sampleOf` (renamed from `sampleFor`) uses compact
  `JSON.stringify`, and the context-budget test's accounting comment already
  reflects it (6,353 sample bytes, ceiling 7,000). This bullet was stale —
  struck through rather than reworked, since there was no remaining code or
  comment to change.
- ~~`withoutId` is copy-then-delete because the eslint config lacks
  `ignoreRestSiblings`~~ — **done.** Added `ignoreRestSiblings: true` and
  switched `withoutId` to `const { id, ...rest } = args`.
- ~~`req.params` uses an `as unknown as` double-cast, safe because `/mcp` has no
  path parameters, but it wants a comment saying so~~ — **done**, with a
  correction: `handleMcp` also serves `/mcp/k/:apiKey`, which *does* have a
  path parameter, so "safe because `/mcp` has no path parameters" was not
  quite right. The cast is sound for a different reason: neither route
  declares a wildcard/splat segment, so every named param (including
  `:apiKey`) is always a single string at runtime, never the `string[]`
  Express 5's `ParamsDictionary` type allows for. The comment in `app.ts`
  states that.
- ~~README orders self-hosting after client setup, though it is a
  prerequisite~~ — **done.** Moved Self-hosting directly after "How it works",
  ahead of both "Connect from..." sections. The "see below" pointer in "How it
  works" stays accurate since Self-hosting is now the next section.
- ~~`/mcp` GET/DELETE returning 405 is undocumented~~ — **done.** Documented in
  "How it works", next to the statelessness explanation it follows from.
- The arm64 image is built under QEMU and executed by nobody. Native
  `ubuntu-24.04-arm` runners would make releases faster and actually test it.
- `ci.yml` and `release.yml` duplicate the smoke-test body verbatim.
- Azure Health check is enabled, but the Dockerfile `HEALTHCHECK` remains inert on
  App Service — kept for other hosts.

## Decisions worth not relitigating

- **Deployment is OIDC from `release.yml`, not a private repo and not a webhook.**
  The webhook required SCM basic auth, which also grants Kudu shell access, and its
  URL embedded those credentials in Docker Hub outside any secret manager. Every
  Azure identifier is a GitHub secret, so this public repo names no instance.
- **63 tools, generated, unfiltered by default.** The surface was chosen
  deliberately over a smaller generic one; `?ops=` / `?resources=` is the escape
  valve and is enforced on `tools/call`, not just `tools/list`.
- **`MAX_PAGE_SIZE = 100`** — verified accepted by the live API, despite a doc
  claiming a limit of 50.
- **The context-budget test exists so surface growth is deliberate.** If it fails,
  justify the delta in the comment beside it rather than raising the number.
- **Field descriptions say when upstream documents nothing** instead of guessing.
  A confident invented description is what caused #35.

## What is proven versus reasoned

Worth knowing which claims rest on observation:

**Verified against the live API or a running container:** the array-filter 500 and
its comma fix; cross-tenant relationship bleed and its closure; path traversal and
its closure; all four auth carriers; filter enforcement on `tools/call`; the
API key never reaching any log channel; pagination honesty; include-traversal for
list-less resources; `page.size: 100`; container non-root, `tini` as PID 1, and
sub-second shutdown; the full release and OIDC deploy chain.

**Reasoned but not observed:** whether Confetti allocates record ids globally
(which decides how reachable the #34 bleed is across tenants); the exact semantics
of several free-form `settings` objects; whether `filter[status]` comma values OR
in all cases or only the ones tested.
