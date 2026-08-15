# v0.2.0 — server wave report

**Branch:** `feat/v0.2.0` · **Date:** 2026-08-15
**Files owned:** `src/server/mcp.ts`, `src/server/app.ts`, `src/tools/errors.ts`,
new `src/server/instructions.ts`, `test/server/mcp.ts`, new `test/server/app.ts`,
`test/tools/errors.ts`, new `test/server/instructions.ts`.
**Scope:** audit ranks 11, 13, 14 · MCP-quality items 6, 7 · the compact-JSON half of MCP item 2.

**Status: done.** 235 tests pass (200 at the start of the wave, +35), `npm run lint`
(eslint + `tsc --noEmit`) clean, `npm run build` clean. Five commits, every file staged by
name. Nothing outside the owned list was touched.

---

## Commits

| sha | subject |
|-----|---------|
| `c0bedc2` | fix: say what went wrong upstream instead of the word "validation" |
| `d46b26a` | fix: give on-call one line per failure, and clients the -32602 they watch for |
| `ea7e7ea` | fix: answer a bad request as a bad request, and advertise the connect filters |
| `a1b4b3c` | feat: orient a model before its first call, from the same data the tools are |
| `ca677d9` | fix: record the upstream status class, not just the error name |

---

## What was done, with its RED evidence

Every item below was written test-first. The RED output quoted is the real failure, and in
each case it fails because the information is *absent*, not because a string differs.

### MCP item 7 — actionable errors (`src/tools/errors.ts`)

RED: 11 of 25 failures in `test/tools/errors.ts`, each showing exactly what a model was
being handed:

```
actual: "Invalid parameters for 'confetti_tickets_create': validation"
        expected: /eventId must be an integer/
actual: "Invalid parameters for 'confetti_tickets_find_all': ignored pretty-printed blob"
        expected: /filter\.eventId: required field is missing/
actual: "Error in 'confetti_events_find_all': [Error] HTTP 500"
        expected: /invalid API key|key is likely wrong|key/i
actual: "Invalid parameters for 'confetti_events_find_all': '…' gave up waiting … after 25000 ms."
        expected: /timed out|timeout/i
```

GREEN, four changes:

1. **Harvest the attached body.** `confetti`'s adapter throws
   `new ParameterError(errorText || 'validation', body)` and `errorText` is `undefined` for
   a JSON body, so the whole message was the word `validation` while the JSON:API `errors`
   array sat on the error object one property away. Own properties are now harvested,
   minus the plumbing (`name`, `message`, `stack`, plus `errorType`, which is confetti's
   verbatim copy of the message, and `code`/`timeoutMs`, which are this server's own),
   bounded at 800 chars, `JSON.stringify` wrapped in try/catch, rendered as
   `Confetti replied: {…}`.
2. **ZodError issues, duck-typed.** `issues` is read structurally — **zod is never
   imported**; it is a transitive dependency of `confetti` only, so an imported copy would
   not be the instance that threw. One line per issue (`- filter.eventId: required field is
   missing`), capped at 10 plus an `…and N more` line, with `invalid_union` collapsed to
   the branch types it would have accepted (both the zod-4 `errors` and zod-3 `unionErrors`
   shapes), `received undefined` → "required field is missing", `received NaN` → "expected
   a number, got a non-numeric value". The issues array *replaces* the pretty-printed
   message rather than joining it — a test pins that the blob does not survive.
3. **Bare `HTTP nnn` guidance,** matched only on a whole-message anchor. The 500 line
   carries the live-verified fact: *api.confetti.events answers 500, not 401, for an
   invalid API key* — so the text tells a model the key is most likely wrong if every call
   fails this way, and to retry once and **not loop** otherwise. 401/403 say do not retry;
   429 says wait; 502/503/504 say transient, one retry.
4. **Timeouts get their own sentence** off `code === 'UPSTREAM_TIMEOUT'` (as the dispatch
   wave arranged), so they no longer read as `Invalid parameters`. The message quotes
   `timeoutMs` from the error; confetti's own 5s/15s numbers are dead under node-fetch v3
   and are never quoted.

Network failures (`FetchError`/`AbortError`, or a message naming `ECONNRESET`/`fetch
failed`/…) get a one-retry sentence. A plain `TypeError` deliberately does **not** — a bug
in this process must not be dressed up as a network problem, and there is a test for it.

Everything still ends in `redact()`; a test drives the caller's key through the *harvested
body* specifically, since that is new ground for the key to reach.

### Rank 11 — blind on-call (`src/server/mcp.ts`, `src/server/app.ts`)

RED: `expected a tool_call_failed line, got []`.

One structured single-line JSON record on stderr, failures only:

```json
{"level":"error","msg":"tool_call_failed","requestId":"…","tool":"confetti_events_find","error":"NotFoundError","upstreamStatus":503,"durationMs":12}
```

The no-request-logging stance is kept intact and the constraint is pinned by tests: the
log carries **no URL, no arguments, no key, and no error message**. Messages are excluded
on purpose — they quote caller data and, for an API that echoes it, the key itself. The
*tool name* is safe because an unknown name is now refused before this point, so it is
always one of the 63 generated names; the *error name* is a class name.

`upstreamStatus` (second RED: `actual: undefined, expected: 503`) is lifted from the
message with a whole-message-anchored `/^HTTP (\d{3})$/`, which matches only when the
message contains nothing else to leak. Without it an outage and a rejected argument both
logged as `"error":"Error"` — precisely the distinction on-call needs.

Request ids are minted per HTTP request in `app.ts` (a middleware ahead of the body
parser, so parse failures are covered too), carried on `res.locals`, and passed into
`createMcpServer`. Tests intercept `process.stderr.write` rather than `console.*`, which
also sidesteps the canary weakness noted as rank 22. A companion test pins that the
**success path stays silent**.

`LOG_LEVEL` is still unwired — see "not done".

### Rank 14 — unknown tool → `-32602` (`src/server/mcp.ts`)

RED: `Missing expected rejection` — the call resolved with an `isError` result.

The unknown-name branch now throws `McpError(ErrorCode.InvalidParams, …)`. The
**distinction is preserved and commented**: a tool that exists but is excluded by
`?ops=`/`?resources=` still returns an `isError` result, because that message is addressed
to the model, which can pick another tool; a name that exists nowhere is a protocol
mistake clients key on to refresh a stale tool list. The existing filtered-tool test
(`/not available on this connection/`) still passes unchanged.

### Rank 13 — malformed / oversized body (`src/server/app.ts`)

RED, all five new tests in `test/server/app.ts`: `actual: 500, expected: 400`,
`actual: 500, expected: 413`, and
`an attacker- or typo-triggerable parse failure must not fill the error log`.

The final handler now branches on what express's body parser already knew:
`entity.parse.failed` → **400 / -32700**, `entity.too.large` → **413 / -32600** (quoting
the 4mb limit from the same constant passed to `express.json`), `encoding.unsupported` →
415, `request.aborted` → 400 — all logged at `warn`, with the genuine 500 / -32603 kept as
the fallback at `error`. The standard `res.headersSent` guard was added. Tests pin that a
malformed body sent to `/mcp/k/<key>` neither echoes nor logs the path key.

### MCP item 2 (deferred half) — compact tool results

RED: `a tool result must not carry indentation`. `JSON.stringify(result, null, 2)` →
`JSON.stringify(result)`. As the dispatch wave noted, results are already envelopes and
confirmations, so nothing else in `mcp.ts` needed to change.

### MCP item 6 — server instructions (`src/server/instructions.ts`)

RED: module did not exist (`ERR_MODULE_NOT_FOUND`), then
`ServerOptions.instructions went unused` for the wiring test.

`buildInstructions(tools)` composes an orientation out of the same data the tools come
from, and **nothing is authored twice**:

- the hierarchy from each model's first `belongsTo` relationship, ordered parent-before-child
  by a depth walk (bounded, so a cyclic registry cannot hang the build);
- the include routes for list-less resources from `includePathFor`/`INCLUDE_PATHS`, with
  the honest sponsors/sponsor-levels fallback;
- "no delete tool exists for …" derived from `listResourceOperations()`, pointing at the
  update tool only when the connection has one — *how* to cancel an event stays in
  `notes.ts` and reaches the model through the tool description;
- the cross-tool facts read verbatim out of `NOTES[key].all`, so those rules keep exactly
  one home (per the schemas wave's note). Operation-scoped notes are deliberately **not**
  duplicated here — they belong to their tool, in context;
- a read-only line only for resources `NOTES` does not already speak for (today: none —
  it exists so a new upstream read-only resource is not silently unmentioned);
- the pagination envelope contract (`{returned, page, more, total, records}`, default 25,
  cap 100, `page.number`), which is stated in no tool description.

It is scoped to the connection's **filtered** set: `?resources=events` is oriented around
events alone. A citation guard drops any sentence naming a tool the connection cannot call
(both `confetti_x_find` names and `confetti_x_*` globs), and a test walks four different
filters asserting every tool name cited exists on that connection. Filtered connections
also get one sentence saying *why* tools are missing.

Sizes: **2032 chars** for the full 63-tool surface, **903** for `?resources=events,tickets&ops=read`;
a test caps it at 2500 so it cannot grow into a second copy of the tool list. Built per
connection but memoised in a `WeakMap` keyed on the tool array `getToolSet` already
memoises, so it costs one registry walk per distinct connect URL.

`GET /` gained a `filtering` line naming `?ops=` and `?resources=` with a worked example —
the one feature that shrinks the ~19k-token surface was invisible at the exact moment
someone configures a connection.

---

## Not done, and why

- **`LOG_LEVEL` is still unwired.** `config.ts` is not mine and `mcp.ts` has no config
  handle. Failure logging is unconditional today, which is the right default for a
  five-line-per-incident volume; wiring the level would mean threading `Config` into
  `createMcpServer`.
- **README/known-deferred not updated.** Both are outside the owned list. Two statements
  there are now stale: `LOG_LEVEL` is documented as "unwired" (still true) but "the server
  performs *no* logging" is not — it logs tool-call failures and bad requests, keys and
  arguments excluded; and the documented `GET /` response now has a `filtering` field.
  Whoever owns docs should pick this up.
- **Rank 20 (end-to-end redaction test) and rank 27 (nock-backed ZodError mapping test)**
  were not in this wave's list. Rank 27 is now cheap: `test/tools/errors.ts` grew a
  duck-typed ZodError fixture, and a nock-driven variant would slot beside it. Rank 20
  still has no test driving a non-`sk_` key through the full server — the third argument
  at `mcp.ts` can still be deleted without any test failing.
- **Success-path logging** is deliberately absent (a test pins the silence). Adding it
  would multiply volume by ~50x for a per-request-key public server whose platform metrics
  already record request counts and latency.

## Notes for later waves / reviewers

1. `logEvent(level, msg, fields)` and `newRequestId()` are exported from `src/server/mcp.ts`
   and used by `app.ts`. If a third logging site appears, that is the moment to move them
   into their own module — I did not create one, since only `instructions.ts` was in scope
   as a new file.
2. The log line's safety argument depends on the unknown-tool branch throwing **before**
   the try/catch: it is what makes `tool` a generated name rather than caller text. Keep
   that ordering.
3. `upstreamStatus` and `httpGuidance` (in `errors.ts`) both anchor on the whole message.
   Loosening either to a substring match would start leaking message content into logs
   and would misclassify prose that merely mentions a status — there is a test for the
   latter.
4. `instructions.ts` reads `NOTES[key].all` directly. If `notes.ts` grows an entry whose
   text names a tool, the citation guard will silently drop it on connections lacking that
   tool — intended, but worth knowing when adding notes.
5. The instructions' hierarchy says "forms contain ticket batches" because
   `ticketBatch.relationships` is `formId`. That is what the registry states; if it is
   wrong, it is wrong upstream and the line will follow the fix automatically.
6. `test/server/app.ts` is new and small; the two body-parser tests are the only place the
   4mb limit is exercised, and it is now a shared `BODY_LIMIT` constant quoted to the
   caller in the 413 message.
