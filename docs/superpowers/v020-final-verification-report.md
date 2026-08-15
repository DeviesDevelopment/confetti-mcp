# v0.2.0 final integration verification

Branch `feat/v0.2.0` @ `eee2ed3`. Verification only — no source file was modified.
Working tree at start and at end contains only the five untracked wave reports.

---

## 1. Gates

| Gate | Command | Result |
| --- | --- | --- |
| Tests | `npm test` | **312 pass, 0 fail, 0 skipped, 0 todo**, duration ~1.2 s |
| Lint | `npx eslint .` | exit 0 |
| Types | `npx tsc --noEmit` | exit 0 |
| Build | `npm run build` | exit 0, `dist/` emitted |
| Lockfile | `npm ci --ignore-scripts --dry-run` | no `EUSAGE`; lock is in sync with `package.json` |
| yayson pin | `npm ls yayson` | `yayson@4.3.0` direct **and** deduped under `confetti@4.1.5` — the dispatch wave's pin holds |

All green. Test count matches the tests wave's claim of 312.

---

## 2. The two controller exploits — both CLOSED

Both were written as throwaway scripts in the repo root, run against the fixed
branch, run again **against a detached worktree at `origin/main` (0055829)** to
prove the scripts genuinely reproduce the bug, then deleted. `git status` is
clean of them.

### (a) Path traversal — CLOSED

Script: `exploit-a-traversal.ts` (deleted). Full HTTP stack — express app,
Streamable HTTP transport, real MCP client, nock-backed upstream.

Connection scoped `?resources=events` lists **4 tools, no payments tool**.

Fixed branch:

```
--- find with id "../payments/7" ---
isError: true
text: [{"type":"text","text":"Invalid parameters for 'confetti_events_find': id must be a single
record identifier made of letters, digits, \"-\" or \"_\" — got \"../payments/7\". Path segments,
empty values and query characters are not allowed."}]
reached /payments/7 ? false

--- delete with id "../payments/7" (connection scoped ?resources=pages) ---
isError: true
reached DELETE /payments/7 ? false

variant "..%2Fpayments%2F7"          -> isError=true
variant "../../payments/7"           -> isError=true
variant "events/1/../../payments/7"  -> isError=true
variant "7?x=1"                      -> isError=true
variant ""                           -> isError=true

EXPLOIT A RESULT: CLOSED — no traversal reached /payments/7, no data leaked.
```

Same script on `origin/main`:

```
reached DELETE /payments/7 ? true
AssertionError: FAIL: traversal reached /payments/7
  true !== false
```

So the script is a real reproduction, and both the find and the delete variant
are now rejected in `requireId` before anything leaves the process. The payment
attributes (`CROSS-RESOURCE-LEAK`) never appear in the caller's response.

### (b) Cross-tenant relationship bleed — CLOSED

Script: `exploit-b-bleed.ts` (deleted). Two concurrent connections on the same
server process, keys `sk_tenant_A` / `sk_tenant_B`, both events referencing
`workspaces/55`; only tenant A's response carries an `included` block.

Fixed branch:

```
--- tenant A ---
{"name":"A conference","id":"1","workspace":{"name":"TENANT-A-PRIVATE-WORKSPACE","id":"55"}}
A sees its own workspace name? true
--- tenant B ---
{"name":"B meetup","id":"2","workspace":{"id":"55"}}
B received tenant A data? false

EXPLOIT B RESULT: CLOSED — tenant B received no tenant A relationship data.
```

Same script on `origin/main`:

```
B received tenant A data? true
AssertionError: FAIL: tenant A workspace bled into tenant B response
```

Tenant B now gets the bare relationship id and nothing else. Tenant A still
resolves its own `included` correctly, so the per-call `Store` did not cost
legitimate resolution.

---

## 3. v0.1.0 security properties — all still hold

Script `verify-security.ts` (deleted). Key used: `super-secret-key-9f3a`
(deliberately not `sk_`-prefixed, so no shape heuristic can help).

```
PASS  404-ish /nope (404) omits the key
      {"jsonrpc":"2.0","error":{"code":-32601,"message":"Not found. Use POST /mcp."},"id":null}
PASS  404-ish /mcp/k/<key>/nope (404) omits the key
PASS  404-ish /mcp/k/<key>x (405) omits the key
PASS  404-ish /<key> (404) omits the key
PASS  ?ops=read&ops=read yields 29 tools           :: got 29
PASS  ?ops=read&ops=read yields 0 delete tools     :: got 0
PASS  a filtered-out delete is refused, not executed  (confetti_pages_delete -> isError)
PASS  upstream 401 body echoing the key is redacted
PASS  upstream 400 body echoing the key is redacted
      "Invalid parameters for 'confetti_events_find': bad request for key [redacted]"
PASS  the redaction is visible to the caller
PASS  find_all still reached the real host with the real key
PASS  no request reached the attacker host (apiHost: evil.example.com ignored)
PASS  create reached the real host
PASS  reserved keys are stripped from the create body
      {"data":{"type":"event","attributes":{"name":"x","startDate":"2026-09-01T10:00:00Z"}}}

ALL SECURITY PROPERTIES HOLD
```

Notes worth recording:

- The repeated-parameter case `?ops=read&ops=read` is the one that used to
  silently disable the filter; it yields exactly 29 and 0 deletes, and the
  filter is *enforced* on `tools/call`, not merely on `tools/list`.
- The 401 path never echoes the upstream body at all (the errors wave maps 401
  to canned guidance), so redaction is proven on the 400 path, which is the one
  that actually surfaces upstream text.
- Reserved keys are inert both as options and inside a create body.

---

## 4. Measurements

Measured with `verify-measure.ts` (deleted), run identically against the fixed
branch and against `origin/main` in a detached worktree.

| Metric | v0.1.0 (`origin/main`) | v0.2.0 (`eee2ed3`) | Δ |
| --- | --- | --- | --- |
| Total tools | 63 | **63** | unchanged ✅ |
| Ops split | 11 findAll / 18 find / 13 create / 11 update / 10 delete | identical | unchanged |
| Field description coverage (top-level properties) | 135/340 = **39.7 %** | 190/340 = **55.9 %** | +55 fields, +16.2 pp |
| Field description coverage (all nested nodes) | 188/452 = 41.6 % | 227/452 = 50.2 % | +8.6 pp |
| Serialized tool list (`tools/list` result) | 67,949 B | **71,093 B** | +3,144 B (+4.6 %) |
| Serialized tool array only | 67,939 B | 71,083 B | +3,144 B |
| `formValues` present in surface | **yes** | **no** | fixed ✅ |

The denominator 340 reproduces the audit's exact count, which confirms the
audit's metric is *top-level schema properties*: its 135/340 (40 %) is now
190/340 (56 %).

Other surface invariants confirmed:

- array nodes carrying a top-level `enum`: **0** (audit rank 3 closed)
- tools whose serialized schema contains `"type":[`: **0** (rank 15 closed)
- annotations present on **63/63**, `openWorldHint: false` on all (rank 16 / MCP 9)
- `PAGE_SCHEMA` description: `"JSON:API pagination. Defaults to a page size of
  25; sizes above 100 are capped."` — the advertised contract now matches the
  `MAX_PAGE_SIZE` clamp.

The size grew rather than shrank. The schemas wave owns this and explained it
(sample dedupe −6.2 KB, breadcrumbs/cross-links/notes +9.4 KB) and pinned it
with a budget test. It is a deliberate trade, not a regression, but "roughly
68 KB" is now wrong in the README (see §6).

Required-field enforcement, flagged by the schemas wave as a gap, is a
non-issue in practice: `confetti`'s own zod runs before any socket opens and
the errors wave formats it well.

```
create {}          -> Invalid parameters for 'confetti_events_create':
                      - name: required field is missing
                      - startDate: expected date or string
tickets find_all {} -> Invalid parameters for 'confetti_tickets_find_all':
                      - filter: required field is missing
```

---

## 5. Docker

```
docker build -t confetti-mcp-verify:local .            -> success
docker run -d -p 18080:8080 confetti-mcp-verify:local  -> up

GET /   -> HTTP 200
{"status":"ok","server":"confetti-mcp","version":"0.1.0",
 "usage":"POST /mcp with an \"Authorization: Bearer <confetti-api-key>\" header.",
 "filtering":"All 63 tools are exposed by default. Narrow the connection with ?ops= and
  ?resources= on the connect URL, e.g. POST /mcp?ops=read&resources=events,tickets —
  the filter is enforced on tools/call, not just tools/list."}

POST /mcp with no key -> HTTP 401
{"jsonrpc":"2.0","error":{"code":-32001,
 "message":"Missing Confetti API key. Send \"Authorization: Bearer <key>\"."},"id":null}

docker inspect .State.Health.Status -> healthy
```

Container and image removed; `docker ps -a` / `docker images` filtered on the
name return nothing.

Workflow hygiene spot-checked: every `uses:` in both workflows is a 40-hex SHA
(no tag refs), both `FROM` lines are digest-pinned, all four `npm ci` calls
carry `--ignore-scripts`, and the release job gates on tag == `package.json`
version before it does anything else.

---

## 6. Not done, and what I think is inconsistent

### Reported NOT DONE by the waves (all still not done — I confirmed each)

| Item | Owner wave | Confirmed state |
| --- | --- | --- |
| Audit rank 6 upstream fix (confetti's module-global yayson `Store`) | dispatch | Mitigated, not closed. Every path bypasses it and a regression test pins the invariant, but the singleton still exists upstream and no issue has been filed. |
| Audit rank 8 — Docker Hub webhook as production trust root | infra (out of scope) | Untouched. Still the largest remaining risk: anyone who can push to the Docker Hub repo owns production and therefore every caller's API key. Scoping `DOCKERHUB_TOKEN` to push-only single-repo is the cheap half. |
| `.github/dependabot.yml` | infra | **Absent** — verified `.github/` contains only `workflows/`. One base-image digest and 7 action SHAs are now frozen with no update bot. |
| `scripts/smoke.sh` | infra | Smoke body is still duplicated verbatim in `ci.yml` and `release.yml`. |
| Azure App Service Health check enablement | infra | Portal change, documented only. |
| `LOG_LEVEL` wiring | server | Still unwired; README line 157 still says "Accepted but not yet wired", so at least README and code agree. |
| Audit rank 20 end-to-end key redaction / rank 27 ZodError mapping tests | server said not-in-scope | Both **were** delivered by the tests wave. Closed. |

### Inconsistencies I found

1. **`package.json` is still `0.1.0`.** This is the one thing I would block a
   release on. The running image reports `"version":"0.1.0"`, and both the
   release job's tag check and the new smoke step compare the image's `GET /`
   version against `package.json` — so pushing a `v0.2.0` tag today fails the
   release at step 3, by design. Bump to `0.2.0` before tagging. Nobody owned
   this file in any wave.
2. **No CHANGELOG and no release note for a breaking response shape.** Reads now
   return `{returned, page, more, records}` instead of a bare array, and deletes
   return `{deleted:true,…}` instead of `""`. This is deliberate and specified,
   but nothing in the repo tells an existing caller. There is no `CHANGELOG.md`
   at all, and the README never documents the tool response shape.
3. **README is stale in three places** (nobody owned it; the infra wave edited
   only the self-hosting section):
   - line 75: "serialises to roughly 68 KB of JSON" — it is now **71 KB**.
   - line 165: the documented `GET /` body predates the new `filtering` field
     and still shows `"version":"0.1.0"`.
   - the README nowhere states that the server now writes structured
     single-line failure logs to stderr; the previous zero-logging stance was a
     documented property.
4. **Stale comment in `test/tools/validate.ts:106-108`** — flagged by two waves
   and still there. It calls the array-level `filter.status` enum "a known
   schema defect"; rank 3 fixed it and I measured 0 array-level enums. The test
   still passes and is still the right test; only the comment lies.
5. **`MAX_PAGE_SIZE = 100` vs the improvements doc's claim that the API tops out
   at 50.** The advertised description and the clamp now agree with each other,
   so this is internally consistent; it is only unverified against the live API.
6. **The deadline cannot cancel the upstream socket** (`confetti` accepts no
   `AbortSignal`). It frees the MCP request and transport only. Against a
   blackholed upstream, sockets still accumulate until TCP gives up. Known and
   documented in `dispatch.ts`; worth an upstream issue alongside rank 6.
7. **Instructions duplicate `NOTES[key].all` verbatim** into both the server
   instructions and the tool descriptions. One source, two renderings — no drift
   risk, ~200 tokens once per session. Intentional; recording it so nobody
   "fixes" it twice.
8. **The tests wave saw a one-off failure** of `a failed tool call is logged as
   one structured line` inside a throwaway mutated worktree. It did not
   reproduce here: I ran the full suite four times on the clean tree, 312/312
   every time. Flagging only so CI flakiness gets attributed correctly if it
   ever appears.

Nothing is broken between waves. The integration points the waves warned about
all hold: `definitions.ts` importing `DEFAULT_PAGE_SIZE`/`MAX_PAGE_SIZE` from
`dispatch.ts` is not a runtime cycle (build and tests pass), the compact
`JSON.stringify` handoff landed, the `raw:true` + per-call `Store` path is
consistent across all five operations, and `?ops=`/`?resources=` filtering is
enforced at call time.

---

## 7. Cleanup

Scripts created, run, and deleted: `exploit-a-traversal.ts`,
`exploit-b-bleed.ts`, `verify-security.ts`, `verify-measure.ts`,
`verify-probe.ts`, `verify-gaps.ts`. The `origin/main` comparison worktree was
removed and `git worktree prune` run.

`git status --porcelain` at end:

```
?? docs/superpowers/v020-wave-dispatch-report.md
?? docs/superpowers/v020-wave-infra-report.md
?? docs/superpowers/v020-wave-schemas-report.md
?? docs/superpowers/v020-wave-server-report.md
?? docs/superpowers/v020-wave-tests-report.md
```

Clean of every throwaway script. (This report adds a sixth untracked file,
matching the other waves' convention.)
