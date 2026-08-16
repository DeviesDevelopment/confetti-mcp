# Test cleanup: `t.after` instead of trailing `close()`, and `--test-force-exit` removed

**Result:** 317 → **318 tests**, all passing. `npm run lint` (eslint + `tsc --noEmit`) and
`npm run build` both clean. `--test-force-exit` removed from `package.json`'s `test` script.
2 commits.

## The defect and the fix

Every server-starting test called `server.close()` (and, in `mcp.ts`, `await
transport.close()`) as the last statement of the test body. When an earlier assertion threw,
that line never ran, the listening handle leaked, and `node --test` hung instead of reporting
the failure — masked in `package.json` by `--test-force-exit`.

Fixed by moving cleanup into `startServer`/`connect` helpers, registered via `t.after`
immediately after the resource is created, so it always runs. Followed `test/server/no-key-in-logs.ts`'s existing pattern. `connect()`'s `t.after` closes only the transport; the
server (shared across multiple `connect()` calls in the concurrent-connection tests) is
closed by exactly one `t.after` per test, registered by `startServer`. Verified empirically
(direct script against the real app, not just reasoning) that closing the server slightly
before an open transport, and closing a transport a second time, are both silent no-ops in
this SDK — so the one place a transport must close before anything else
(`test/server/mcp.ts`'s "a later connection never inherits" test, where tenant D must connect
only after tenant C's transport is actually closed) keeps its explicit `await
c.transport.close()` inline, since that's a functional precondition, not cleanup.

Files touched: `test/server/app.ts`, `test/server/mcp.ts`, `test/server/url-auth.ts`,
`test/server/health.ts`, `package.json` (test script only). No `src/` file changed.

## Fail-fast verification

For each file, inserted `assert.equal(1, 2)` into a test that starts a server, ran that file
alone with the new script (no `--test-force-exit`), confirmed a fast non-zero exit, then
reverted and confirmed `git diff` was clean before moving to the next file.

| File | Test mutated | Exit code | Duration |
|---|---|---|---|
| `test/server/health.ts` | `GET / reports server identity` | 1 | ~384ms |
| `test/server/app.ts` | `an unparseable body is the client's fault: 400 / -32700` | 1 | ~420ms |
| `test/server/url-auth.ts` | `the path-carried key is the key sent upstream` (exercises `connect()`/transport cleanup) | 1 | ~495ms |
| `test/server/mcp.ts` | `concurrent connections do not leak api keys across requests` (two concurrent transports sharing one server) | 1 | ~669ms |

All four failed and exited within a second — none hung. `npm test` afterward: 318/318
passing, exit 0, ~2.9s.

## The 500-path test

`src/server/app.ts`'s error middleware has a branch distinct from the `ToolFilterError` 400
branch and the `clientFault` 4xx branches: the generic 500, which logs only `error.name` and
returns a static body, deliberately never the URL or the error message, because the `/mcp/k/<key>` carrier puts the caller's key in the path.

Nothing reachable through crafted HTTP input reaches that branch — `extractApiKey` and
`getToolSet` are total over their inputs; every malformed-input path already lands in
`clientFault` or `ToolFilterError`. To reach it without modifying `src/`, the new test in
`test/server/app.ts` uses node's built-in module mocking
(`t.mock.module`, gated behind `--experimental-test-module-mocks`, now added to the test
script) to make `createMcpServer` throw a `TypeError` for the duration of one test, then
does a cache-busted dynamic `import()` of `app.js` so the fresh module instance resolves its
`mcp.js` import against the mock (the file's top-level static import had already bound to
the real module before the mock existed). Asserts: status 500, `error.code === -32603`,
`error.message === 'Internal server error.'`, and that neither the request path (`/mcp/k/<key>`) nor the key itself appears anywhere in the response body. This was achievable
and is in place — nothing was left out.

## Commits

- `1b9c5c5` — `t.after` cleanup in `health.ts`, `mcp.ts`, `url-auth.ts` (317/317 green on its
  own, verified via `git stash` of the other two files before running).
- `f031780` — `t.after` cleanup + the new 500-path test in `app.ts`, and the `package.json`
  script change (drop `--test-force-exit`, add `--experimental-test-module-mocks`). 318/318
  green.

Nothing was left out or deferred.
