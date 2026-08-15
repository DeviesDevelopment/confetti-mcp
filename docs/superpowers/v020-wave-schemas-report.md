# Wave: schemas — v0.2.0 report

Branch `feat/v0.2.0`. Files owned and touched: `src/tools/definitions.ts`,
`src/tools/notes.ts` (new), `src/confetti/resource-map.ts`,
`test/tools/definitions.ts`, `test/tools/notes.ts` (new),
`test/confetti/resource-map.ts`. Nothing outside that list was edited.

Final state: **200 tests pass, 0 fail**; `npm run lint` (eslint + `tsc --noEmit`) clean.

Commits:

| sha | subject |
| --- | --- |
| `8a822de` | feat: map the include path that reaches each list-less resource |
| `d841565` | feat: one table for the facts the registry cannot state |
| `b1487f7` | fix: publish schemas a model can satisfy and descriptions it can act on |

---

## What shipped, item by item

### Audit rank 2 — findAll schemas omitted required filters

`findAllSchema` now reads `BaseFilter.required` from the entries it already
iterates, emits `required: [...]` on the filter object and `required: ['filter']`
at the top level. Verified live: `ticket`, `payment` and `ticketBatch` are the
three models with `filters.eventId.required === true`; every other find_all is
unchanged and still publishes no `required`.

RED before the fix:

```
✖ find_all tools advertise the filters upstream makes mandatory
  AssertionError: confetti_tickets_find_all must require filter
    actual: undefined, expected: [ 'filter' ]
```

### Audit rank 3 — `filter.status` enum on the array instead of its items

Post-processed in `findAllSchema`: an array-typed filter property that carries a
top-level `enum` gets `items: {type:'string', enum:[…]}` and loses the array-level
`enum`. A whole-surface test now walks every schema node and asserts no
array-typed node anywhere carries a top-level `enum`, so a new upstream array
filter cannot reintroduce it.

RED before the fix:

```
✖ filter.status carries its enum on items, so the schema is satisfiable
  AssertionError: an array-level enum can never be satisfied
    actual: [ 'attending', 'waitlist', 'declined', 'invited', 'consumed', 'deletion-requested' ]
    expected: undefined
✖ no array-typed schema anywhere carries a top-level enum
  actual: [ 'confetti_tickets_find_all.properties.filter.properties.status',
            'confetti_payments_find_all.properties.filter.properties.status' ]
```

Note: the two enums differ (tickets = attending/waitlist/declined/invited/
consumed/deletion-requested; payments = paid/refunded/…-invoice), so the test
checks each against its own value.

### Audit rank 15 — `ID_SCHEMA` union type

`{type:'string', description:'Record id. A number is accepted too.'}`. A test
asserts no schema in the surface contains `"type":[` at all.

**Correction to the audit:** it says the union appears on 41 tools. It is **39**
— find (18) + update (11) + delete (10). The test pins 39 with a comment.

RED: `confetti_events_find.id must be single-typed — actual: [ 'string', 'number' ]`.

### Audit rank 16 + MCP quality 9 — human titles, `openWorldHint`

`title` is now `<verb> <subject>`: `List Events`, `List Ticket Batches`,
`Delete Sponsor Level`, `Update Form Field`. find_all pluralises from the
resource name (`ticketBatches` → `Ticket Batches`); the others use `model.name`.
`openWorldHint: false` is on all 63 (the spec default is `true`, which would
claim these calls can reach anywhere). `ToolAnnotations` gained the field as a
required property, so a future annotation cannot silently omit it.

RED: `actual: 'confetti_events_find_all', expected: 'List Events'` and
`confetti_events_find_all must not claim an open world — actual: undefined`.

### Audit rank 24 — the partial-update promise

Test `no upstream update schema has a required field` walks all 11 update
schemas through `schemaToJsonSchema` and asserts `required` is empty/absent, with
a message that names the model and says the `required:['id']` promise is broken.
This is a drift guard: it passes today by construction. Its RED was demonstrated
by pointing the same assertion at the create schemas, which do have required
fields — it fails with
`models.block.operations.create now has required fields`.

### Audit rank 26 — sanity guard on generated schemas

`assertObjectSchema(schema, label)` is exported and called for every generated
`findAll` and body schema. It throws when the value is not a `type:'object'`
schema, when `properties` is missing/empty, or when the serialised schema
contains a `$ref` (the `$defs` block would be dropped by the rebuild, leaving a
dangling reference). Unit-tested against all four shapes, including the
`anyOf` shape the unreachable `previewToken` model already has. Two
whole-surface tests back it: no `$ref`/`$defs` anywhere, and every input schema
is an object schema with properties.

### MCP quality 3 — one sample per resource, compact

The sample goes on `find_all` where one exists, **otherwise on `find`** — the
else-branch is load-bearing: the seven list-less resources would otherwise lose
their only shape documentation, and a test names all seven. The non-carrying
`find` gets `Returns the same record shape as confetti_<resource>_find_all.`
Samples are single-line `JSON.stringify`.

Measured: samples fell from **12,524 to 6,353 bytes**; carriers from 29 to 18
(one per mapped resource, asserted).

### MCP quality 4 — Zod meta recovery and date unions

After `schemaToJsonSchema`, the Zod shape is walked in parallel
(`config.schema.shape`, `.meta()` per field) and merged **fill-gaps-only**:

- `helpText` (+ `placeholder` as `Example: …`) fills an empty `description`;
  an upstream `description` always wins (pinned by a test on `ticket.comment`).
- `values` fills the missing enum — on the bare string branch of a union where
  there is one, otherwise on a plain string property. This is what makes
  `ticket.status`'s only legal values (`attending`, `invited`) visible.
- bare Title-Case `label` echoes are never shipped (131 of them are just the
  field name); the same rule strips echo labels off filter descriptions
  (`eventId` → "Event Id"), leaving room for the cross-link.
- `anyOf[{string,date-time},{string}]` collapses to a single
  `{type:'string', format:'date-time'}` with a description saying *date or
  date-time* is accepted (8 sites). `ticket.checkinAt` keeps its `null` branch
  and loses only the bare string branch.

Two smaller quality fixes came out of reading the generated output: recovered
helpText is punctuated before another sentence is appended (`Required for ticket
events. Obtain from …`, previously a run-on), and a `placeholder` is skipped when
the helpText already carries an example (`contact.phone` said "Example" twice).

### MCP quality 5 — descriptions from registry data + `notes.ts`

`describe()` composes:

1. the operation lead sentence;
2. `Required: …` — filter keys for find_all, body fields for create;
3. `Belongs to: event (eventId), ticketBatch (ticketBatchId)` from
   `model.relationships`, restricted to fields the body can actually set (that is
   why `parentTicketId` does not appear — it is not in the ticket create schema);
4. the breadcrumb for a list-less resource, on **every** operation of that
   resource: `No list tool for Speakers: enumerate them with
   confetti_events_find, include: ["speakers"].`, or for sponsor/sponsorLevel the
   honest fallback `… and no event include: keep the id from
   confetti_sponsors_create.`;
5. the notes for that (resource, operation);
6. the sample, or the pointer to the tool that carries it.

Property-level `*Id` cross-links are appended in the same mechanical pass, to
body properties **and** filter properties: `Obtain from confetti_events_find_all.`
→ falls back to the event include for form/formField → falls back to
`Obtain from the confetti_sponsor_levels_create response.` A prefix that names no
resource (`blockStyleId`, `themeId`, `sectionId`) gets nothing rather than an
invented tool name.

`src/tools/notes.ts` holds one `NOTES` table — 11 entries across 8 resources,
each ≤300 chars, guarded by dead-key tests (unknown resource, unknown/absent
operation, table size, "read-only" claimed for a resource that has write tools,
and every `confetti_*` name mentioned must be a tool that is generated). MCP
item 6 (`instructions`) should consume `NOTES`/`notesFor` and
`INCLUDE_PATHS`/`includePathFor` rather than restating any of it.

Dead-key RED, produced by injecting bad keys:

```
✖ NOTES.ticketBatchs names no mapped resource
✖ NOTES.event2.delete would never be shown — that operation does not exist
✖ FIELD_DESCRIPTIONS.ticket.formValues overrides a field that no longer exists
✖ INCLUDE_PATHS.scheduleItem = "scheduleItems" is not in Confetti.models.event.includes
```

### CRITICAL — the `formValues` lie

`FIELD_DESCRIPTIONS.ticket.values` overrides the upstream description (the one
place fill-gaps-only yields). It now reads:

> Form field answers, keyed by each field's name (e.g. {"dietary-needs":
> "Vegan"}). Field names come from confetti_form_fields_find; titles and ids are
> not accepted, and answers sent under any other argument are ignored.

The word `formValues` is gone from the whole surface (tested on create and
update). A companion test asserts the **upstream** description still contains
`formValues`, so the day the package is fixed the override fails and can be
deleted rather than silently masking better upstream prose.

---

## Numbers

| | v0.1.0 | now |
| --- | --- | --- |
| tool list, serialised | 67,926 B | 71,066 B |
| — sample records | 12,524 B | 6,353 B |
| — other description prose | 3,313 B | 9,377 B |
| — input schemas | 40,315 B | 43,911 B |
| tests | 178 | 200 |

The surface grew ~4.6%. The doc's estimate for items 3–5 was roughly
break-even; the real cost of the breadcrumbs (25 tools), the id cross-links
(~50 properties) and the notes is larger than estimated. I trimmed where it was
free — dropped `page.offset`/`page.limit`/`page.size` prose in favour of one
sentence on `page` that names the cap, shortened the id, date and breadcrumb
sentences — and stopped there rather than cutting content the reports call
load-bearing. The size test is now an explicit budget (`< 72,000` bytes, plus
`samples < 7,000`) with the accounting in a comment, so the trade stays
deliberate instead of drifting.

---

## Notes for later waves

1. **`test/tools/validate.ts` has a now-stale comment** (not my file): the test
   `an array value is checked against its item enum, not the array-level enum`
   says filter.status "ships its enum on the array rather than on items (a known
   schema defect)". Rank 3 fixed that; the test still passes (item-level
   enforcement is correct under both spellings, exactly as the dispatch wave
   predicted) but the comment now describes something that no longer exists.
2. **`required` is advertised but not enforced locally.** `validateArgs` does not
   check required fields, so `confetti_tickets_find_all {}` still travels
   upstream and comes back as a ZodError. Advertising it is the fix rank 2 asked
   for; enforcing it pre-dispatch (one loop over `schema.required`) belongs to
   whoever owns `validate.ts` and would turn a round-trip into an instant,
   actionable message.
3. **New enum enforcement side effect.** `ticket.create.status` now carries
   `enum:['attending','invited']` on its string branch (recovered meta), so
   `validateArgs` rejects other statuses at create time. That is the behaviour
   the improvement doc asks for, but it is stricter than upstream Zod, which
   accepts any string there. If a legitimate third create status turns up, the
   fix is upstream `values` meta, not a special case here.
4. **`definitions.ts` now imports `DEFAULT_PAGE_SIZE`/`MAX_PAGE_SIZE` from
   `dispatch.ts`** so the advertised page contract cannot drift from the clamp.
   `dispatch.ts`'s import of `definitions.ts` must stay `import type` — it is
   today — or that becomes a runtime cycle.
5. **PUT vs PATCH is still unverified.** The improvement doc asks whether update
   is really partial-update semantics; `resources.js` sends PUT and I had no way
   to test against the live API from here. I removed the claim rather than
   restate it: update descriptions now say "Pass only the fields you want to
   change" (true of the request this server builds) instead of "Only the fields
   you pass are changed" (a claim about server behaviour). A test asserts the old
   sentence is gone from all 11 update tools. If someone verifies PUT replaces,
   this needs a warning note, and `NOTES` is where it goes.
6. **Description coverage** is still far from complete — MCP item 8 (the
   docs-derived field table) is not in this wave. The merge point for it already
   exists: `enrichFromZodMeta` is fill-gaps-only and runs per model key, so a
   `field-docs.ts` table can be merged in the same walk without touching
   anything else.

## Not done

Nothing from the assigned list was skipped. The one thing I could not *verify*
rather than implement is the PUT/PATCH semantics above.
