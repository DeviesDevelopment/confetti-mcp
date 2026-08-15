# confetti-mcp: Final Improvement Plan (2026-08-15)

Synthesised from six lens reviews and a completeness critique. 26 raw recommendations reduce to 9 changes; the cuts are listed at the end. Every item states what a model cannot do reliably today and what it can do after.

## Summary

**What is already good.** The generated-tool architecture is the right call and is executed cleanly: all 63 tools come from one loop over the upstream registry (`src/tools/definitions.ts:176-191`), so new upstream resources and fields appear with zero server changes. The `?ops=`/`?resources=` connect-URL filter is real security, not decoration — `createMcpServer` builds `byName` from the *filtered* set and refuses excluded tools on `tools/call`, not just `tools/list` (`src/server/mcp.ts:48-68`). API keys are exact-match redacted out of every error path (`src/tools/errors.ts:13-18`), reserved connection keys (`apiKey`, `apiHost`, `apiProtocol`, `raw`) are stripped from caller args so a caller cannot redirect requests (`src/tools/dispatch.ts:47-53`), update schemas correctly require only `id` (`definitions.ts:118-128`), and read tools ship a sample record so the model knows response shapes. The server is honestly stateless and self-hostable.

**What holds it back.** Three failure classes, in order of severity:

1. **Silent false success.** Upstream Zod strips unknown body keys, so `confetti_events_update {id: 5, titel: 'X'}` parses to `{}`, sends an empty PUT, and returns success — the model can never detect the failure. Worse, one *existing* description actively causes this: `confetti_tickets_create.values` tells agents to "prefer passing `formValues`", a field that does not exist anywhere in the package — following the tool's own advice silently drops the attendee's form answers.
2. **Blind pagination.** `find_all` returns a bare array (yayson `store.sync` discards JSON:API `meta`/`links`), page size defaults to 25, and nothing distinguishes "all 25 records" from "first 25 of 300". Every counting task silently truncates. The module-level shared yayson `Store` in the adapter also bleeds cached relationship records across requests — and across tenants on a multi-tenant deployment.
3. **Discarded documentation.** 205 of 340 input fields have no description because upstream's `schemaToJsonSchema` deletes `label`/`helpText`/`placeholder`/`values` meta (`node_modules/confetti/dist/utils/to-json-schema.js:11`), write-tool descriptions are one templated sentence, and cross-resource facts (7 resources have no list tool; events cannot be deleted; ticket batches cannot be created via API) live nowhere.

The plan fixes false-success first, pagination second, then reinvests the token budget freed by de-duplicating sample records into descriptions the generator can maintain.

**Honest context accounting** (the reviews double-spent this): the sample dedupe frees ~1.7k tokens once. The description work adds roughly +4–5k tokens total. Net: the ~19k-token tool list grows to roughly ~21–22k, in exchange for field-description coverage going from 40% to ~95% and every cross-resource trap being documented. That trade is worth making, but the list does not stay flat.

---

## START HERE

| # | Change | Why first |
|---|--------|-----------|
| 1 | Pre-dispatch validation + fix the `formValues` lie | False success is the only failure a model can *never* detect or repair; it poisons every other workflow. |
| 2 | Response envelope (`raw:true`, per-call Store, pagination, delete confirmation, compact JSON) | Kills silent truncation and cross-request Store bleed in one rewrite of the single return path. |
| 3 | Sample dedupe | Trivial, frees ~1.7k tokens/session, and funds the description work that follows. |

One focused session covers items 1–3 plus item 4 (Zod-meta recovery, ~30 lines). Items 5–7 are a second session; 8–9 are cleanup.

---

## The Plan

### 1. Pre-dispatch validation against the advertised schema — and kill the phantom `formValues`

**Impact: transformative · Effort: medium · Files:** new `src/tools/validate.ts` (~80 lines), `src/tools/dispatch.ts` (one call at top of `callTool`), `src/tools/definitions.ts` (description override), tests.

**What a model cannot do today:** detect that a write silently did nothing. Verified: `confetti_events_update {id: 5, titel: 'New Name'}` — upstream Zod strips the unknown key, the body parses to `{}`, an empty PUT is sent, and the tool returns **success**. No error exists for the model to react to. Same mechanism, worse instance: `confetti_tickets_create.values` carries the description *"Agents using MCP should prefer passing formValues, which resolves field titles or IDs to field names automatically"* — `formValues` matches nothing in `node_modules/confetti/dist/` except that string. A model that obeys the tool's own documentation loses the attendee's form answers silently. Separately, `include: ['nope']` and unknown filter keys pass client validation and come back as bare `HTTP 500`, and `startDate: 'next friday'` is accepted by the bare-string branch of the date union and dies post-network as an unattributable 500.

**Change:** one generic `validateArgs(tool.definition.inputSchema, args)` called first in `callTool()` (`dispatch.ts:55`), driven entirely by the already-generated schema — zero per-tool code:

- Reject top-level keys not in `properties`, listing valid keys (`unknown field "titel". Valid fields: name, startDate, … Did you mean "name"?`).
- Same check one level down for create/update bodies — but **do not recurse into free-form objects**: `block.content` and `ticket.values` are `looseObject` by upstream design; validate only where the generated schema declares `properties`.
- Enforce advertised enums (`sort`, `include` items, filter sub-keys) and echo the allowed values on failure, instead of letting the API answer `HTTP 500`.
- For update, error on an empty body: `'confetti_events_update' called with no updatable fields besides id.`
- For properties with `format: 'date-time'`, reject values failing an ISO shape check with the fix in-message: `startDate: 'next friday' is not a valid date — provide ISO 8601, e.g. '2026-09-01' or '2026-09-01T18:00:00Z'`. Accept plain dates (`2026-09-01`) — the API does.

And delete the lie: in the schema post-processing (item 4's walk), override `ticket.values`' description with: `Form answers, keyed by form-field name. (Do not use 'formValues' — it does not exist.)` This is the one place "never overwrite existing descriptions" must yield; a false description is worse than none. While in there, do a one-pass accuracy read of the other 134 existing descriptions.

**Context cost:** zero on success paths; error responses grow ~30–80 tokens only when the model has already erred — each such error replaces a doomed retry loop.

### 2. Response envelope: fetch raw, sync per-call, return pagination + confirmations, print compact

**Impact: transformative · Effort: medium · Files:** new `src/tools/shape.ts`, `src/tools/dispatch.ts` (pass `raw: true` for reads, call shaper; wrap delete), `src/server/mcp.ts:74` (compact stringify), `package.json` (yayson as direct pinned dep), tests.

**What a model cannot do today:** distinguish "25 records is everything" from "first 25 of 137". Verified: yayson `store.sync({meta:{total:137}, links:{next:…}, data:[…]})` returns only the flattened array — meta and links are gone before dispatch sees them. Asked "how many tickets have we sold?", the model answers "25" for an event with 137. It also cannot confirm a delete: a 204 surfaces as the literal text `""` (`adapter.js:62-65` + `mcp.ts:74`), so models re-issue deletes "to be sure" (the retry 404s and reads as failure). Additionally — found by the critique, decisive and named by nobody — the adapter's **module-level shared yayson Store** caches records across *all requests and all API keys in the process*: unbounded memory growth, and relationship data merged from earlier requests, i.e. nondeterministic (and on multi-tenant hosts, potentially cross-tenant) reads.

**Change:** the upstream options schemas already accept `raw: boolean` (verified in `node_modules/confetti/dist/schemas/resource-options.js`), and dispatch already reserves the key (`dispatch.ts:47`). For find/findAll, pass `raw: true`, then in `shape.ts`: flatten with a **per-call** `new Store()` (fixes the shared-store bleed), read `body.meta`/`body.links` off the raw JSON:API body, and return:

```json
{ "returned": 25, "page": { "number": 1, "size": 25 },
  "more": "yes", "records": [ … ] }
```

`more` = `links.next` present, else `returned === size` heuristic (the public docs' list examples show no meta, so do not depend on it; the heuristic is the honest maximum). Empty results become `{"returned": 0, …, "records": []}` — unambiguous versus today's `[]`. Delete returns `{ "deleted": true, "resource": "webhook", "id": 91 }`; any other empty-body success returns `{ "ok": true, "operation", "resource", "id" }`. Keep `DEFAULT_PAGE_SIZE` at 25 — the bump to 50 doubles glance-cost and exposure to the adapter's hardcoded 5s GET timeout (see item 6).

Change `mcp.ts:74` to `JSON.stringify(result)` — measured, indentation is ~19% of every read response (25 events: 6,598 → 5,341 tokens).

Dependency hygiene (from the critique): importing yayson makes a transitive dep load-bearing. Declare it a **direct** dependency pinned to confetti's version, with a test asserting the versions agree — the same rule that rightly forbids importing zod directly in item 7.

**Context cost:** +~40 tokens/list response for envelope keys; net **−~1,200 tokens** per 25-record page from compact printing.

### 3. Ship each sample record once, compact

**Impact: moderate · Effort: trivial · Files:** `src/tools/definitions.ts` (`sampleFor`/`describe`), tests.

**What a model loses today:** nothing functional — this is pure waste. `sampleFor(m)` (`definitions.ts:50-54`) appends the identical pretty-printed sample to **both** `find` and `find_all` (`definitions.ts:153-155`): measured 12.5–13.7KB of the 68KB tool list, ~18% of the whole surface, duplicated verbatim per resource.

**Change:** attach the sample to `find_all` when it exists, **else to `find`** — the else-branch matters: form, formField, speaker, organiser, scheduleItem, sponsor, and sponsorLevel have no `find_all`, and the naive "find_all only" version (proposed identically by three reviewers) would delete their only shape documentation. The non-carrying read tool gets one sentence: `Returns the same record shape as confetti_<resource>_find_all.` Compact the sample with single-line `JSON.stringify(sample)` — pretty-printing costs ~30% extra for zero information.

**Context cost:** **−~6.3KB (~1.7k tokens)** per full-surface session. This funds items 4–6.

### 4. Recover the stripped Zod meta and collapse the date unions

**Impact: high · Effort: small · Files:** `src/tools/definitions.ts` (~40-line helper called from `bodySchema`, `definitions.ts:105`), tests. Reference: `node_modules/confetti/dist/utils/to-json-schema.js:11`.

**What a model cannot do today:** create a ticket correctly on the first call. Upstream's `schemaToJsonSchema` has `const metaKeysToStrip = ['label','helpText','placeholder','values']` and deletes them — human-written docs exist and are thrown away. Verified casualties: `tickets_create.sendEmailConfirmation` is **required** yet its meaning ("If set to true, an email confirmation will be sent to the attendee / invitee" — i.e. it *is* the invite email) exists only in stripped meta, so a model setting it `true` "to be safe" emails real attendees; `ticketBatchId`'s stripped helpText is "Required for ticket events"; `status` serialises as `anyOf[bare string, array-of-enum]` so its only valid values (`attending`, `invited`) are invisible — they live solely in the stripped `values` meta; `contact.phone`'s format example `+46701234567` is stripped. The schema also tells the model any string is a valid `startDate`: `anyOf:[{type:'string',format:'date-time'},{type:'string'}]`, no description.

**Change:** do not touch upstream. After `schemaToJsonSchema(config.schema)`, walk `config.schema.shape` in parallel with the JSON Schema (Zod v4 `.meta()` reads from the registry — verified it returns the payloads at runtime) and merge, fill-gaps-only:

```ts
function enrichFromZodMeta(shape: Record<string, any>, json: JsonSchemaObject) {
  for (const [field, sub] of Object.entries(shape)) {
    const prop = json.properties[field] as any
    if (!prop) continue
    const meta = sub.meta?.() ?? {}
    const extra = [meta.helpText, meta.placeholder && `Example: ${meta.placeholder}`]
      .filter(Boolean).join(' ')
    if (!prop.description && extra) prop.description = extra
    if (Array.isArray(meta.values) && meta.values.every((v: unknown) => typeof v === 'string')) {
      const bare = prop.anyOf?.find((b: any) => b.type === 'string' && !b.enum)
      if (bare) bare.enum = meta.values
      else if (prop.type === 'string' && !prop.enum) prop.enum = meta.values
    }
  }
}
```

In the same walk, collapse `anyOf[string/date-time, string]` to `{type:'string', format:'date-time', description:'ISO 8601 date or date-time, e.g. "2026-09-01" or "2026-09-01T18:00:00Z"'}` — the description must say "date **or** date-time" because the API accepts plain dates. Item 1's validator then enforces what this schema now honestly advertises. Skip bare `label` meta — 131 of them are Title-Case echoes of the field name ("Rsvp Limit"), worthless.

**Context cost:** +~1KB (~250 tokens).

### 5. Real tool descriptions from registry data + one `notes.ts` for everything the data cannot say

**Impact: high · Effort: small–medium · Files:** `src/tools/definitions.ts` (rewrite `describe()`, `definitions.ts:149-163`; `*Id` cross-link pass), new `src/tools/notes.ts` (one table), `src/confetti/resource-map.ts` (include-path map), tests.

**What a model cannot do today:** plan a multi-step workflow from descriptions. `confetti_tickets_create`'s full description is "Create a new Ticket in Confetti." (31 chars). Nothing states that tickets belong to events, that `sponsorLevelId` comes from `confetti_sponsor_levels_create`, that speakers/organisers/scheduleItems/forms/formFields/sponsors/sponsorLevels have **no list tool** (verified: only find/create/update/delete) — asked "list the speakers for DevSummit", the model hunts for `confetti_speakers_find_all`, doesn't find it, calls `events_find` *without* `include` (gets no speakers), and concludes there are none. Nothing states events have no delete ("remove the test event" must become `events_update {status:'cancelled'}`), or that ticketBatches and forms cannot be created via the API at all.

**Change — three mechanical passes plus one small table** (the critique is right that reviewers' 500-char "example texts" were hand-written descriptions in disguise; hold the line at generation + one sentence per resource/op):

1. **Generated from data** in `describe()`: `Required: <generated.required.join(', ')>` from the body schema; `Belongs to: event (eventId), ticketBatch (ticketBatchId)` from `m.relationships` (verified present on the registry), with tool cross-references built via `toolName()`.
2. **Mechanical `*Id` cross-links**: for each property matching `/^(.+)Id$/` whose prefix resolves in `RESOURCE_MAP` (eventId, formId, sponsorLevelId, ticketBatchId, workspaceId, pageId, blockId, imageId; `blockStyleId`/`themeId` mechanically skip), append `Obtain from confetti_<res>_find_all` — or the breadcrumb below when no list tool exists. Append-only, never overwrites.
3. **Generated breadcrumbs for the 7 list-less resources**: driven by a small map in `resource-map.ts` (`{ speaker: 'speakers', organiser: 'organisers', scheduleItem: 'schedule-items', form: 'forms.form-fields', formField: 'forms.form-fields' }`, tested against `Confetti.models.event.includes`), emitting: `There is no list tool for Speakers. To enumerate an event's speakers, call confetti_events_find with include: ["speakers"].` sponsor/sponsorLevel appear in no event include (verified) and get the honest fallback: ids come from create responses — retain them.
4. **One `NOTES` table** in `notes.ts` — `Partial<Record<ModelKey, Partial<Record<Operation | 'all', string>>>>`, ≤18 short entries, each a fact that crosses tool boundaries: events cannot be deleted, cancel via `status:'cancelled'`; ticket events need a `ticketBatchId` and batches cannot be created via the API (Confetti UI only); `sendEmailConfirmation:true` emails immediately; publishing (`status:'open'`) requires a verified account; `tickets_find_all` is effectively event-scoped — pass `filter.eventId`. Guard with a dead-key test (fail on any NOTES/breadcrumb key not matching a live resource/property) so upstream renames fail loudly. **This table is the single home for these facts** — item 6's instructions consume it too; the ticketBatch rule must not live in four places.

Also verify against the live API whether update is truly PATCH-semantics: the description promises "Only the fields you pass are changed" but `resources.js` sends **PUT**. If the API replaces on PUT, today's description on the most-used write tool invites data loss — fix the sentence to match reality before enriching it.

**Context cost:** +~3–4KB (~1k tokens) across write and no-list tools.

### 6. Server-level `instructions`, generated from the same data

**Impact: high · Effort: small · Files:** new `src/server/instructions.ts` (~60 lines), `src/server/mcp.ts:43-46` (pass `instructions`), `src/server/app.ts`'s `GET /` usage string, tests.

**What a model cannot do today:** orient. The SDK 1.30.0 `ServerOptions.instructions` field goes unused; the 63 descriptions are islands, and the resource tree (workspaces → events → {pages → blocks → images, forms → formFields, ticketBatches → tickets, …}) must be reverse-engineered from field names, typically via 2–3 failed calls.

**Change:** `buildInstructions(tools)` composed from `RESOURCE_MAP`, `listResourceOperations()` (which already knows read-only resources and missing ops), `Confetti.models[*].relationships`, and item 5's `NOTES`/breadcrumb tables — one ~20-line paragraph: resource tree, the include-traversal rule for the 7 list-less resources, read-only resources (payments, categories, ticketBatches, workspaces), no-delete-events/cancel idiom, pagination default (25/page, API max 50), publish gating. Because `getToolSet()` already computes the filtered set per connection, scope the string to the connection's resources — a `?resources=events,tickets` connection gets two lines. Stateless, regenerated per filter, stays in sync with upstream automatically.

Also fix the adjacent discoverability gap the critique found: the `GET /` discovery response never mentions `?ops=`/`?resources=` — the one feature that shrinks the 19k-token surface is invisible at the exact moment someone configures a connection. Add one line to the usage string.

**Context cost:** +~400–600 tokens once per session, only on clients that inject instructions; zero on `tools/list`.

### 7. Error messages a model can act on

**Impact: high · Effort: small · Files:** `src/tools/errors.ts`, tests.

**What a model cannot do today:** self-correct after a server-side rejection. Four verified dead ends: (a) an HTTP 400 with a JSON body throws `ParameterError(errorText || 'validation', errorOptions)` — `errorText` is undefined for JSON bodies, so the model reads the single word **"validation"**, while the API's JSON:API `errors` array sits on the error object (Object.assigned by the constructor) one property away from `toolErrorMessage()`, which only reads `.message` (`errors.ts:30-51`); (b) ZodError messages pass through as the pretty-printed issues array — ~60 lines for one wrong field, with union failures (all date fields) reading "Invalid input" at top level; (c) any unhandled status is `[Error] HTTP 500` — and, live-verified with curl, **api.confetti.events returns 500 for an invalid API key**, indistinguishable from an outage, so the model retries in a loop instead of telling the user their key is wrong; (d) the adapter's hardcoded node-fetch timeouts (5s GET / 15s write) surface as raw `[FetchError] …` with no guidance — a class no reviewer mapped.

**Change**, all in `errors.ts`, all error-path only:

- **Harvest the attached body**: for `ParameterError`/`NotFoundError`, append a compact `JSON.stringify` of own-properties (`errors`, `error`, `detail`, `meta` — everything but name/message/stack), through the existing `redact()`. (401/403/422/5xx bodies are discarded inside the adapter before we see them — upstream item, see below.)
- **Format ZodError issues**: when `Array.isArray((error as any).issues)`, render one line per issue — dotted path + message; collapse `invalid_union` to "expected <branch types> or …"; map "received undefined" → "required field is missing", "received NaN" → "expected a number, got a non-numeric string". Duck-type the issues array — **do not import zod** (transitive-only; version drift with the throwing instance).
- **Map bare `HTTP nnn`**: match `/^HTTP (\d{3})$/` and append per-class guidance — 401/403: key invalid or lacks access, verify the connect-URL key; 429: wait before retrying; **500: "the Confetti API currently returns 500 for an invalid API key — if every call fails this way, the key is likely wrong or revoked; otherwise possibly transient, retry once, do not loop"**; 502/503: transient, one retry.
- **Map FetchError/timeouts**: name the 5s/15s limits, suggest a smaller `page.size` or fewer `include`s for slow lists, one retry for connection resets.

**Context cost:** error-path only; validation blobs shrink 3–5×, the useless ~10-token messages grow to ~40–80 useful tokens.

### 8. Docs-derived field-docs table — explicitly an interim shim

**Impact: high (finishes the coverage story) · Effort: medium · Files:** new `src/tools/field-docs.ts` (~250 lines of data), `src/tools/definitions.ts` (~20-line fill-gaps merge in `schemaFor`/`findAllSchema`), one test.

**What a model cannot do today:** fill an events_create body without probing. After items 4–5, ~190 fields still have no description — the stripped meta only ever covered ~11. The public docs have real prose for nearly all of them (verified verbatim for `/api/events/create` and `/api/tickets/list`): `signupStartAt: 'Registration opening time'`, `slug: 'URL-friendly event identifier'`, `primaryColor: 'Main brand color used for buttons, links, and accent elements'`, `privacyPassword: 'Required when privacy settings use password mode'`. Filter descriptions are bare labels ("Event Id", "Search") from `filterToJsonSchema`.

**Change:** a flat data table keyed by `ModelKey` then field name (`filter.`-prefixed keys for find_all filters), seeded from docs.confetti.events/api verbatim — a one-time authoring pass of a couple of hours, mirroring *public* docs, nothing Devies-internal. Merge fill-gaps-only, so generated/meta text always wins and upstream improvements shrink the table over time. Because `EventUpdateSchema = EventCreateSchema.partial()`, one entry covers create and update. Guard with the **dead-key test only** (fail on any key not matching a live property); per the critique, drop the ≥90%-coverage-floor test — it turns every upstream minor release that adds a field into a red CI.

**Frame it honestly:** this is a hand-copied mirror of the docs, exactly the posture the generated architecture exists to avoid. File the upstream request (fold `helpText` into `description` in `schemaToJsonSchema`) on day one and schedule this table for deletion as upstream meta improves.

**Context cost:** +~8–10KB (~2.5k tokens) — the single biggest addition; this is where the net list size goes from ~17.5k (post-dedupe) to ~20–21k tokens. Coverage goes to ~95%.

### 9. Annotation polish: human titles, `openWorldHint: false`

**Impact: marginal · Effort: trivial · Files:** `src/tools/definitions.ts` (`annotate()`, `definitions.ts:165-174`), snapshot test.

**Today:** `annotations.title` is set to the tool name itself (`annotate(m, operation, name)` passes `name` straight through), so permission UIs show `confetti_ticket_batches_find_all` where "List Ticket Batches" belongs; `openWorldHint` is omitted and its spec default is *true*, signalling these closed-API tools might reach anywhere.

**Change:** title from a 5-entry verb map (`findAll:'List'` (pluralised), `find:'Get'`, `create:'Create'`, `update:'Update'`, `delete:'Delete'`) + `m.name`; add `openWorldHint: false`. Leave the existing readOnly/destructive/idempotent hints — they are already correct.

**Context cost:** ~0.

---

## Considered and rejected

- **Workflow Prompts (setup-event, event-status-report)** — human-invoked, minority-client feature that does nothing for autonomous tool selection; two hand-written scripts encoding publish-gating rules would rot fastest of anything proposed. Cut.
- **`confetti://reference/<resource>` Resources** — assumes the model can pull MCP resources on demand; in most hosts resources are user/host-attached. The valuable half (sample dedupe) shipped as item 3. Cut.
- **`structuredContent` in CallTool results** — doubles wire payload, needs per-client verification the model isn't fed the result twice, benefit is hypothetical client tables. Defer indefinitely.
- **Page size 25 → 50** — doubles glance-at-page-1 cost and exposure to the adapter's hardcoded 5s GET timeout, to optimise the rarer exhaustive scan that item 2's envelope already makes cheap to continue. Dropped.
- **Length-heuristic-only pagination envelope (rec 11)** — strictly superseded by the `raw:true` envelope (item 2), which also fixes the shared-Store bleed.
- **≥90% description-coverage CI floor** — guarantees red CI on every upstream release that adds a field; kept only the dead-key half.
- **Hand-authored 500-char per-tool description texts** — the reviewers' "example texts" were 63 hand-written descriptions in disguise; item 5 holds the line at generated composition + ≤18 one-sentence notes.
- **Four separate homes for the same facts** — RESOURCE_NOTES, HINTS, breadcrumb map, and instructions preambles merged into one `notes.ts` consumed by both `describe()` and `buildInstructions()`.
- **Importing zod for error formatting** — transitive-only dependency; duck-type the issues array instead. (Yayson, which item 2 *does* import, is promoted to a direct pinned dependency with a version-agreement test — same hazard, consistent resolution.)
- **Strict `format:'date-time'` collapse** — the API accepts plain `2026-09-01`; the collapsed schema and validator say and accept "date or date-time" so local validation never rejects valid input.

## Needs upstream (confetti npm package / Confetti API)

File these on day one; each has a shipping workaround above.

| Upstream change | Why | Workaround until then |
|---|---|---|
| Stop stripping meta: fold `helpText`/`values` into `description` in `schemaToJsonSchema` (or rename the meta keys) | Fixes every consumer forever in a few lines; makes item 8's 250-line docs mirror deletable | Items 4 + 8 (fill-gaps-only, so they self-retire) |
| Remove/rename the phantom `formValues` in `ticket.values`' description | Actively steers agents into silent data loss | Item 1's override + unknown-key rejection |
| Attach the response body to non-400 errors (401/403/422/5xx currently discarded in `adapter.js`; 500+ never even read) | The MCP layer cannot surface what it never receives | Item 7's status-class guidance |
| Return 401, not 500, for invalid API keys (API-side) | 500-for-bad-key is indistinguishable from an outage | Item 7's live-verified 500 hint |
| Search/date filters: `filter[search]` on events and contacts, `filter[startDateAfter/Before]` on events; findAll endpoints for the six find-only resources; enum + description for `image.type`; bulk create / event duplicate | Turns 30–50-call scan traces into 3–5 calls; `image.type`'s valid values are documented nowhere (docs show only `ticket.attending`) | Items 5–6 teach the include-traversal and list-and-match patterns; item 2 makes exhaustive scans terminate correctly |
| Configurable fetch timeouts (hardcoded 5s GET / 15s write) | Slow list calls with includes hit the guillotine | Item 7's timeout guidance (smaller pages, fewer includes) |

Because the tools are registry-generated, every upstream filter, endpoint, or meta improvement appears in the MCP surface automatically with zero server changes — the strongest argument for investing upstream rather than accumulating server-side special cases.
