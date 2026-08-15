# v0.2.0 — wave `tests` report

**Scope:** audit ranks 6a, 20, 22, 23, 25, 27, 28, 29. Files touched: `test/**` only.
**Result:** 235 → **312 tests**, all passing (3 consecutive full runs), `npm run lint`
(eslint + `tsc --noEmit`) clean. 5 commits.

---

## Method: how RED was established with the source frozen

Every item in this wave is a *missing guard*, not a live bug, so "write the failing test
first" cannot mean "the test fails against today's code" — today's code is correct. What a
missing guard must be shown to do is **fail when the property it claims to protect is
violated**, while the pre-existing suite stays green. That is the audit's own claim for
each of these findings, so it is what I demonstrated.

I created a **detached `git worktree` at `HEAD` in the scratchpad**, with `node_modules`
symlinked in, and applied each mutation there. The main working tree was never modified
outside `test/**` — no stash of another wave's work, no window in which `src/` was wrong,
no risk to a concurrent agent. The worktree has been removed.

For rank 6a specifically, the dispatch note said to either stash wave 1's `shape.ts` change
or construct the module-global equivalent: **I did the shape.ts revert, in the worktree** —
`flatten()` rewritten to use one module-scope `const sharedStore = new Store()`, which is
exactly the construction `confetti/dist/adapter.js:8` uses and exactly the pre-wave-1
behaviour.

Each mutation below was reverted immediately after its run.

| Rank | Mutation applied at `HEAD` | Pre-existing suite | New test(s) |
|---|---|---|---|
| 6a | `shape.ts` `flatten()` → one module-scope `Store` | 308/312 | ✖ both isolation tests |
| 20 | `mcp.ts` drops the 3rd arg to `toolErrorMessage` | 311/312 green (18/18 in `test/server/mcp.ts` at HEAD) | ✖ redaction test |
| 22 | morgan-shaped `process.stdout.write(req.originalUrl)` middleware in `app.ts` | 9/9 url-auth green | ✖ both canaries |
| 23 | `auth.ts` "sanitises" the path key (`replace(/[^A-Za-z0-9]/g,'')`) | 9/9 url-auth green | ✖ path + percent-encoded tests |
| 25a | `formFields.update` reordered to `(id, options, json)` (arity unchanged) | 298/299 green | ✖ `confetti_form_fields_update` |
| 25b | `pages.delete` loses its options argument | — (4 existing delete tests also fail) | ✖ arity guard, naming `Confetti.pages.delete takes 1 arguments, not 2` |
| 27 | upstream validation failures renamed `ZodError` → `ValidationError` | 301/302 green | ✖ real-zod coupling test |
| 28 | `toolName` yields `confetti_form.fields_find` | old "every name is legal" test **passed** | ✖ new loop over 63 |
| 29 | `DEFAULT_PAGE_SIZE = 50` | 81/81 green in the two files | ✖ literal-25 + description tests |

---

## What was added, per rank

### Rank 6a — cross-request isolation (the reason the critical finding exists)

`test/server/mcp.ts`

- **`two concurrent connections never see each other records`** — two MCP connections with
  different bearer keys, both `tools/call` in flight together via `Promise.all`. Tenant A's
  event carries `relationships.workspace → {workspaces, 5}` **with** an `included` block
  holding `Tenant A Workspace` / `A-only-data`; tenant B's event references the **same
  `(type,id)`** and ships **no `included`** — the exact precondition for the bleed. B's
  response is `delay(60)`ed so A's deserialisation is guaranteed to land first (the
  ordering the bleed needs) while both calls are genuinely concurrent.
  The test asserts A *does* get its own included record first — a fixture that silently
  stopped including anything would make "B saw nothing" prove nothing — then asserts B's
  result contains neither string.
- **`a later connection never inherits an earlier one records`** — the sequential half. A
  store that is never reset keeps records for the life of the process, so the disclosure
  needs no concurrency, only that the other tenant called at some point since boot. The
  first connection is fully closed before the second opens.

RED output under the module-global Store:

```
✖ two concurrent connections never see each other records (76.118625ms)
  AssertionError: tenant A's workspace bled into tenant B's response
✖ a later connection never inherits an earlier one records (16.305ms)
```

(Wave 1's own dispatch-level test and shape.ts unit test also fail under that mutation —
4 failures total — which is the correct outcome; the two above are the end-to-end,
two-key, concurrent statement of the invariant that did not exist before.)

### Rank 20 — end-to-end key redaction

`test/server/mcp.ts` → `an upstream error that echoes the caller key never reaches the
client`. The bearer key is **`tenant-alpha-9f3c`**, deliberately not `sk_`-shaped, so the
shape regex in `redact()` cannot cover for a missing exact-match. nock replies `401` with a
`text/plain` body echoing the key — confetti's adapter puts that body verbatim into the
`Error` message (`adapter.js:92`), so it reaches `toolErrorMessage` unchanged. Asserts the
`isError` text omits the key **and** contains `[redacted]` (absence alone could be luck).

RED with the third argument dropped:

```
AssertionError: the caller's api key reached the client: Error in
'confetti_events_find_all': [Error] Invalid credentials for apikey tenant-alpha-9f3c
```

### Rank 22 — the logging canary now watches the streams

`test/server/url-auth.ts`. `captureOutput()` intercepts `process.stdout.write` **and**
`process.stderr.write` (forwarding to the originals so the test reporter still works), which
is a strict superset of `console.*` — Node's global console writes through these streams,
which is why wave 3's `console.error` logging is visible to it.

As instructed, the assertion is **not** "nothing is logged" — wave 3 added deliberate
failure logging. It is "the key never appears". A second test drives a *failing* tool call
through the path carrier and asserts `tool_call_failed` **is** present in the output before
asserting the key is not: a canary watching a request that logs nothing is worthless.

### Rank 23 — the url carriers are followed upstream

`test/server/url-auth.ts`, three new `tools/call` tests using the real MCP client with **no
Authorization header at all**, each with a nock `reqheaders: { authorization: 'apikey …' }`
matcher and `scope.done()`:

- `/mcp/k/sk_path_key` → `apikey sk_path_key`
- `/mcp?apiKey=sk_query_key` → `apikey sk_query_key`
- `/mcp/k/sk_path%2Bkey%2Fwith%3Dchars` → `apikey sk_path+key/with=chars` (express decodes
  the route param; this pins that it is decoded exactly once, which the mangling mutation
  above breaks and nothing else caught)

The previously-unused `nock` import in that file is now used.

### Rank 25 — 63 real calls instead of 6

New file **`test/tools/call-signatures.ts`** (63 tests). For every generated tool it pins:

- the HTTP method and the exact URL path (so `id` is argument one),
- the connection options reaching the adapter (`authorization` header on every call,
  `page[size]` on every list — a list query can only come from the options object),
- for create/update, a request body that carries the caller's own field. This is the sharp
  one: the adapter only emits a body `if (json)`, so a swapped argument order produces an
  empty POST/PUT or, as in the demo, `missing_api_key`.

Arguments are generated **from each tool's own advertised `inputSchema`** (required fields
recursively, honouring `enum`, `anyOf`, and the `date-time`/`email`/`uri`/`uuid` formats),
not from per-model fixtures — so a new upstream resource is covered the day it appears, and
the fixtures cannot drift from the advertised contract. All 63 round-trip today.

`test/confetti/resource-map.ts` gains `every operation keeps the call signature dispatch
relies on` — `Function.length` for all 63 against `{findAll:1, find:2, create:2, update:3,
delete:2}` (verified against the shipped package). Note the honest limit, demonstrated
above: **arity does not move when arguments are merely reordered** — 25a is caught only by
the integration matrix, 25b only cheaply by the arity guard. Both are needed.

### Rank 27 — error names pinned against the packages that throw them

`test/tools/errors.ts` gains a section driving **real** rejections through `callTool`:

- a genuine zod failure (`{page:{size:'not-a-number'}}` — no nock scope; it rejects inside
  confetti's own `.parse` before any request) asserting `error.name === 'ZodError'` and the
  `Invalid parameters` mapping with `page.size` surviving as an issue line;
- a real `400` → `ParameterError`, asserting the harvested JSON:API body reaches the message;
- a real `404` → `NotFoundError` mapping (previously pinned only at the name level in
  `test/tools/dispatch.ts`, never through `toolErrorMessage`);
- `OperationNotFoundError` cannot be provoked by any tool call, so it is pinned by reading
  the package's own `dist/errors.js` (located via `createRequire.resolve('confetti')`, not a
  hardcoded `node_modules` path) for `this.name = '…'`.

### Rank 28 — every name, not one

`test/tools/names.ts` loops all 63 `buildTools()` names against
`/^[a-zA-Z0-9_-]{1,128}$/`, asserts the count is 63 first (a loop over an empty list passes
vacuously), and adds a uniqueness/prefix check.

### Rank 29 — the contract, not the constant

`test/tools/dispatch.ts` now asserts the literal `'25'` on the wire instead of
`String(DEFAULT_PAGE_SIZE)`. `test/tools/definitions.ts` pins the other half: every
`find_all` description must state the number the server will actually apply, plus
`DEFAULT_PAGE_SIZE === 25`. Behaviour and documentation now fail together or not at all.

---

## Notes for later waves / the release owner

1. **`test/server/instructions.ts` already pins the default page size** from the
   instructions side (`states the pagination contract, which no tool description states`) —
   it failed under the `DEFAULT_PAGE_SIZE = 50` mutation. So the number is now pinned in
   three places (request, tool descriptions, instructions). Anyone deliberately changing it
   changes one constant and three tests, by design.
2. **`test/tools/errors.ts` is no longer a pure unit file** — it imports `nock`,
   `buildTools` and `callTool` and has an `afterEach(nock.cleanAll)`. If the errors wave
   edits it, keep the cleanup hook.
3. **The ZodError coupling test deliberately does not use `confetti_tickets_find_all {}`.**
   That would have been the audit's example, but the schemas wave notes `required` is
   advertised and *not* enforced by `validateArgs`; if a later wave adds required-field
   enforcement, that call would start throwing `ParameterError` locally and the test would
   break for an unrelated reason. `{page:{size:'not-a-number'}}` reaches upstream zod under
   either policy.
4. **`test/tools/call-signatures.ts` hardcodes `page[size] === '25'`** for list calls
   (rank 29's literal). A deliberate `DEFAULT_PAGE_SIZE` change fails all 11 `find_all`
   cases there too.
5. **The `validate.ts` comment noted by the schemas wave is still stale** — `test/tools/
   validate.ts:'an array value is checked against its item enum'` calls the array-level enum
   a known defect; rank 3 fixed it. I left it: it is a comment inside a test the schemas
   wave reasoned about, and the wording is theirs to correct.
6. **Nothing outside `test/**` was touched.** No source bug was found while writing these —
   every property the audit predicted would hold, held.
7. **Stability:** the full suite was run 3× consecutively at 312/312. One unrelated
   one-time failure of `a failed tool call is logged as one structured line` was observed
   *inside the mutated worktree* during a parallel full run and did not reproduce there in
   isolation or in the main tree across three runs. Worth a second look if it ever recurs in
   CI; I could not reproduce it.

---

## Commits

| sha | subject |
|---|---|
| `ee6f80f` | test: prove two tenants cannot see each other, end to end |
| `5824ed8` | test: watch the streams, and follow a url-carried key upstream |
| `2116e45` | test: call all 63 operations for real, not six of them |
| `f02a115` | test: pin the error names against the packages that throw them |
| `eee2ed3` | test: check every name, and the 25 the descriptions promise |
