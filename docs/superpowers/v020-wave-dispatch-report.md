# v0.2.0 — Wave `dispatch` report

**Branch:** `feat/v0.2.0` · **Baseline:** 111 tests · **Final:** 154 tests, all passing ·
`npm run lint` (eslint + `tsc --noEmit`) and `npm run build` clean.

Files touched (all within the wave's ownership, plus `package-lock.json` — see Concerns):
`src/tools/dispatch.ts`, new `src/tools/validate.ts`, new `src/tools/shape.ts`,
`package.json`, `package-lock.json`, `test/tools/dispatch.ts`, new `test/tools/validate.ts`,
new `test/tools/shape.ts`.

---

## Commits

| SHA | Subject | Covers |
|---|---|---|
| `ce0dd06` | fix: allowlist record ids so a scoped connection cannot traverse paths | audit rank 1 |
| `1061372` | fix: build upstream options from an allowlist, and pin the guard on all five ops | audit ranks 4, 21 |
| `2d3b251` | fix: reject a malformed page and clamp caller page sizes | audit ranks 9, 10 |
| `011aa81` | fix: put a real deadline around every upstream call | audit rank 5 |
| `4ef6cd2` | feat: validate tool arguments against the advertised schema before dispatch | MCP item 1 |
| `02467fd` | feat: shape responses per call, ending the shared-Store bleed and blind pagination | MCP item 2 (+ audit rank 6, partially) |

Each commit is test-first: the test was written, run, and observed failing for the right
reason before the implementation existed. The RED evidence is recorded below.

---

## What was done, with the RED that justified it

### Rank 1 — id path traversal (`ce0dd06`)

`requireId` only type-checked, so the id went raw into `${model.path}/${id}` and WHATWG URL
parsing collapsed the dot segments.

RED (before the fix), reproducing exactly the controller-verified bypass:

```
✖ a traversal id cannot reach another resource (4.278666ms)
  AssertionError [ERR_ASSERTION]: Missing expected rejection.
✖ a traversal id cannot delete another resource (2.881167ms)
  AssertionError [ERR_ASSERTION]: Missing expected rejection.
✖ an empty or whitespace id is rejected instead of hitting the collection route
  AssertionError [ERR_ASSERTION]: Missing expected rejection.
✖ ids with query or fragment characters are rejected
  + actual - expected
  + 'Error'
  - 'ParameterError'
```

"Missing expected rejection" is the important part: the request *did* go out, and the nock
scope for `GET /payments/7` (and `DELETE /webhooks/9`) matched it.

Fix: `ID_PATTERN = /^[A-Za-z0-9_-]+$/` in `requireId`, throwing the existing ParameterError
shape. Covers Confetti's numeric ids and hashids; rejects empty/whitespace, `/`, `\`, `?`,
`#`, `..`, percent-encodings and spaces. `requireId` now returns a `string` (it always went
into a URL path anyway).

### Rank 4 — denylist → allowlist (`1061372`)

`RESERVED_OPTION_KEYS` was a hand-maintained mirror of `confetti`'s `baseOptionsSchema`,
which fails open the moment upstream adds a key. Replaced with
`CALLER_OPTION_KEYS` — `findAll: filter, sort, include, page`; `find: include`; the three
write ops take **no** caller options — assembled by an exported `callerOptions()`.

RED: `SyntaxError: The requested module '../../src/tools/dispatch.js' does not provide an
export named 'callerOptions'` — the fail-closed builder did not exist. The test feeds a
hostile argument object containing `basePath` and `apiVersion` (stand-ins for the next
upstream option key) and asserts they never appear in the built options.

Create/update body handling is unchanged apart from also stripping the four reserved keys
out of the body, so they cannot be smuggled through it. Verified programmatically that no
generated schema across all 63 tools advertises a field named `apiKey`, `apiHost`,
`apiProtocol` or `raw`, so this can never drop a real field.

### Rank 21 — cannot-redirect guard on all five operations (`1061372`)

Extended the reserved-key regression test to `create`, `update` and `delete` via a small
loop (legit scope with a `reqheaders` key match + an evil-host scope;
`legit.isDone() && !evil.isDone()`). As the audit states, these three were already safe by
construction, so these tests pass without a code change — they are a regression guard, not
a bug fix, and are reported as such.

### Ranks 9 + 10 — page handling (`2d3b251`)

RED:

```
✖ a non-object page is rejected instead of silently returning page 1
✖ an oversized page size is clamped
✖ an oversized page limit is clamped
```

`page: 2` / `"2"` / `"second"` / `[]` / `null` are now rejected with a message naming the
expected shape, before any request goes out (previously replaced with the default, so the
model got page 1 with no signal). `page.size` and `page.limit` are clamped to
`MAX_PAGE_SIZE = 100`; the existing "explicit page size overrides the default" test uses
100, so that boundary stays green and legitimate calls are unaffected.

### Rank 5 — real upstream deadline (`011aa81`)

RED, with a 2s nock delay and a 40 ms deadline:

```
✖ a hung upstream call is abandoned at the deadline (2007.329625ms)
```

2007 ms elapsed and the call *resolved*: nothing bounded it, exactly as the audit describes
(node-fetch v3 ignores `timeout`).

`callTool` now wraps `dispatch()` in `withDeadline()` — `Promise.race` against an unref'd
timer, cleared in a `finally`. Default `DEFAULT_TIMEOUT_MS = 25_000`, overridable per
connection via the new optional `CallContext.timeoutMs`. The rejection is
ParameterError-shaped (as instructed) and names the limit, and additionally carries
`code: 'UPSTREAM_TIMEOUT'` and `timeoutMs` — see Notes for later waves.

`AbortSignal` is deliberately *not* used: `confetti` accepts no signal, so nothing this
server can do cancels the in-flight socket. The deadline frees the MCP request and
transport, which is the leak that mattered; the upstream fix is still worth filing.

### MCP item 1 — pre-dispatch validation (`4ef6cd2`)

New `src/tools/validate.ts`, driven entirely by `tool.definition.inputSchema`. Zero per-tool
code — pinned by a test asserting the source contains no `confetti_` literal.

RED (stub `validateArgs` that does nothing): 5 of 11 tests failed, each with
`<tool> accepted <args>`; the 6 acceptance tests passed, showing the tests discriminate.

Rules implemented:

- **Unknown top-level keys** rejected, listing the valid fields and a Levenshtein
  "Did you mean …?" when one is close (`nmae` → `name`).
- **Unknown keys one level down** rejected the same way (e.g. `filter.eventid`), but
  **never recursing into free-form objects**: a node whose `properties` is empty or which
  carries a permissive `additionalProperties` (`looseObject` upstream — `block.content`,
  `ticket.values`, guest `values`) is left alone.
- **Advertised enums enforced**, echoing the allowed values (`sort`, `include[]`, filter
  sub-keys, `block.type`, `block.status`).
- **Update with nothing but an id** rejected, naming example fields.
- **Non-ISO dates** rejected with the correction in the message; plain `2026-09-01`,
  `…T18:00:00Z`, `…+02:00` and millisecond forms all accepted, because the API takes them.

Two deliberate design decisions worth reviewing:

1. **Array-level `enum` is not enforced.** `filter.status` on tickets/payments ships its
   enum on the array instead of on `items` (audit rank 3, owned by the definitions wave).
   Enforcing it would reject `["attending"]` — every legal value. Item-level enforcement is
   correct under *both* the current and the fixed spelling, so this needs no follow-up when
   rank 3 lands. A test pins it.
2. **The four connection keys are ignored, not rejected.** They are stripped by the dispatch
   allowlist and cannot influence the request; and the reserved-key regression tests — here
   *and* in `test/server/mcp.ts`, which this wave does not own — assert that such a call
   still completes against the real host with the trusted key. Rejecting them would have
   failed a test in another wave's file.

`required` is **not** enforced locally: audit rank 2 (missing `required` on filter-mandatory
findAll tools) belongs to the definitions wave, and enforcing a wrong `required` list here
would break legitimate calls.

### MCP item 2 — response envelope + per-call Store (`02467fd`)

RED — the cross-tenant bleed reproduced end-to-end through `callTool`, two different API
keys, tenant B's record carrying a linkage-only `workspace` reference with no `included`:

```
✖ one tenant never receives another tenant relationship record (7.523208ms)
  AssertionError [ERR_ASSERTION]: tenant A's workspace must not appear
✖ find_all returns an envelope that reports pagination
✖ an empty find_all page is distinguishable from a full one
✖ a delete is confirmed rather than returning an empty string
```

Implementation:

- `baseOptions()` now always sets `raw: true`, for **all five** operations, not only reads.
  The shared-Store bleed applies to create/update responses too, and passing `raw` there
  produces an identical flat record via our own Store, so there was no reason to leave those
  two paths on the process-global one. This also makes the "any other empty-body success"
  branch reachable and meaningful.
- `src/tools/shape.ts` flattens with a **per-call `new Store()`**.
- Reads return `{ returned, page: { number, size }, more, records }`. `more` is `'yes'` when
  `links.next` exists, `'no'` when links exist without it or the page is short, and
  `'likely'` when there is no links object and the page came back full — the honest maximum
  the heuristic supports. `total` is included only when `meta` actually carries
  `total`/`totalCount`/`count`; nothing depends on it.
- Deletes return `{ deleted: true, resource, id }`; any other empty-body success returns
  `{ ok: true, operation, resource, id }`.
- `yayson` is now a **direct dependency pinned to `4.3.0`**, the version `confetti@4.1.5`
  resolves, with a test asserting our pin, confetti's pin and the installed version all
  agree — a second copy would mean two Stores and two record shapes.

---

## Not done (and why)

- **`JSON.stringify(result)` (compact) in `src/server/mcp.ts:74`** — part of MCP item 2, but
  `mcp.ts` belongs to wave 3. Handed over below rather than edited.
- **Audit rank 6 is only *mitigated*, not closed.** Every path this server takes now bypasses
  the module-global Store, and there is a regression test for the bleed. The dependency
  singleton itself still exists in `confetti`; the upstream fix (per-call Store or
  `store.reset()`) should still be filed.
- **Audit ranks 2, 3** (schema `required` / `filter.status` enum placement) — definitions
  wave. My validator is already written to be correct before and after both.

---

## Notes for later waves

- **Wave 3 (`src/server/mcp.ts`)**: change `JSON.stringify(result, null, 2)` to
  `JSON.stringify(result)`. Measured upstream at ~19% of every read response. Tool results
  are now envelopes/confirmations rather than bare arrays and empty strings, so nothing in
  that file needs to know the shape — it still just stringifies.
- **Wave 3**: `CallContext` gained an optional `timeoutMs`. `DEFAULT_TIMEOUT_MS` (25 s) is
  exported from `dispatch.ts`. If an env-driven timeout is wanted, wire it in `config.ts`
  and pass it through the context — dispatch deliberately reads no environment itself.
- **Errors wave (MCP item 7, `src/tools/errors.ts`)**: the timeout rejection is
  ParameterError-named as instructed, which today renders as
  `Invalid parameters for '<tool>': … gave up waiting …`. It also carries
  `code: 'UPSTREAM_TIMEOUT'` and `timeoutMs`, so that wave can duck-type the code and give
  timeouts their own sentence without string-matching the message. Note that the adapter's
  own 5s/15s numbers are dead — do not quote them; quote `error.timeoutMs`.
- **Definitions wave**: when rank 3 moves `filter.status`'s enum onto `items`, no change is
  needed in `validate.ts`; the test
  `an array value is checked against its item enum, not the array-level enum` keeps passing
  and starts rejecting genuinely invalid statuses.
- **Definitions wave**: `PAGE_SCHEMA`'s description should mention the new ceiling
  (`MAX_PAGE_SIZE = 100`) so the advertised contract matches the clamp.

---

## Concerns

1. **`package-lock.json` is not in my file list but had to change.** Declaring `yayson` a
   direct dependency without regenerating the lock would break `npm ci` in CI and in the
   Docker build. I ran `npm install --package-lock-only --ignore-scripts`; the diff is
   exactly two lines (the root `dependencies` entry). No package versions moved.
2. **Response shape is a breaking change for any existing caller** — deliberate and specified
   (MCP item 2), but v0.2.0 release notes should say so plainly: reads return an envelope
   with `records`, not a bare array; deletes return an object, not `""`.
3. **`MAX_PAGE_SIZE = 100` is a judgement call.** The improvements doc says the API tops out
   at 50; I clamped at 100 so the pre-existing "explicit page size 100" test stays
   meaningful, and because a server-side memory bound does not need to second-guess the API's
   own limit. Lower it to 50 if the API max is confirmed.
4. **The timeout cannot cancel the upstream socket** — only the MCP-side wait. Under a
   genuinely blackholed upstream, sockets still accumulate until TCP gives up. The real fix
   is upstream `AbortSignal` support.
