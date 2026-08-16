import { test } from 'node:test'
import assert from 'node:assert/strict'
import Confetti, { schemaToJsonSchema } from 'confetti'
import { assertObjectSchema, buildTools } from '../../src/tools/definitions.js'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../../src/tools/dispatch.js'
import { listResourceOperations } from '../../src/confetti/resource-map.js'

const tools = buildTools()
const byName = new Map(tools.map((t) => [t.definition.name, t]))

type Props = Record<string, Record<string, unknown>>

function definition(name: string) {
  const tool = byName.get(name)
  assert.ok(tool, `${name} not generated`)
  return tool.definition
}

function props(name: string): Props {
  return definition(name).inputSchema.properties as Props
}

function nested(parent: Record<string, unknown>): Props {
  return parent['properties'] as Props
}

function description(schema: Record<string, unknown>): string {
  const value = schema['description']
  return typeof value === 'string' ? value : ''
}

test('generates exactly 63 tools', () => {
  assert.equal(tools.length, 63)
})

test('tool names are unique', () => {
  assert.equal(byName.size, 63)
})

test('every tool has a non-empty description and an object input schema', () => {
  for (const tool of tools) {
    assert.ok(tool.definition.description.length > 0, `${tool.definition.name} has no description`)
    assert.equal(tool.definition.inputSchema.type, 'object')
  }
})

test('events_create exposes the create schema including workspaceId', () => {
  const schema = definition('confetti_events_create').inputSchema
  assert.ok('name' in schema.properties)
  assert.ok('startDate' in schema.properties)
  assert.ok('workspaceId' in schema.properties, 'workspaceId must NOT be stripped')
  assert.deepEqual(schema.required, ['name', 'startDate'])
})

test('events_update requires id alongside the update fields', () => {
  const schema = definition('confetti_events_update').inputSchema
  assert.ok('id' in schema.properties)
  assert.ok(schema.required?.includes('id'))
})

test('tickets_find_all exposes a sort enum because ticket has sorting', () => {
  const sort = props('confetti_tickets_find_all')['sort']
  assert.ok(sort, 'tickets should expose sort')
  assert.ok((sort['enum'] as string[]).includes('createdAt'))
})

test('events_find_all omits sort because event has no sorting', () => {
  assert.equal(props('confetti_events_find_all')['sort'], undefined)
})

test('events_find_all exposes filter and include', () => {
  const filter = props('confetti_events_find_all')['filter']
  assert.ok(filter)
  const signupType = nested(filter)['signupType']
  assert.ok(signupType)
  assert.deepEqual(signupType['enum'], ['rsvp', 'tickets'])

  const include = props('confetti_events_find_all')['include']
  assert.ok(include)
  const items = include['items'] as { enum?: string[] }
  assert.ok(items.enum?.includes('categories'))
})

test('contacts_find_all omits filter because contact has no filters', () => {
  assert.equal(props('confetti_contacts_find_all')['filter'], undefined)
})

test('find and delete tools take id', () => {
  for (const name of ['confetti_forms_find', 'confetti_pages_delete']) {
    assert.ok('id' in props(name))
    assert.deepEqual(definition(name).inputSchema.required, ['id'])
  }
})

test('every find_all exposes page', () => {
  for (const tool of tools) {
    if (tool.operation !== 'findAll') continue
    assert.ok('page' in tool.definition.inputSchema.properties, `${tool.definition.name} lacks page`)
  }
})

test('page documents the size cap the server actually enforces', () => {
  const page = props('confetti_events_find_all')['page']
  assert.ok(page)
  const text = description(page) + description(nested(page)['size'] ?? {})
  assert.match(text, new RegExp(String(MAX_PAGE_SIZE)), 'the clamp must be advertised')
})

test('every find_all advertises the default page size it actually applies', () => {
  // The advertised default and the applied default are two separate literals:
  // one lives in PAGE_SCHEMA's description, the other in DEFAULT_PAGE_SIZE.
  // Pinning both to 25 here — and to the same 25 the request carries in
  // test/tools/dispatch.ts — is what stops a tweak to the constant from
  // leaving 11 tool descriptions telling a model a false number.
  assert.equal(DEFAULT_PAGE_SIZE, 25, 'the documented default is 25')
  for (const tool of tools) {
    if (tool.operation !== 'findAll') continue
    const page = (tool.definition.inputSchema.properties as Props)['page']
    assert.ok(page, `${tool.definition.name} lacks page`)
    assert.match(
      description(page),
      new RegExp(String(DEFAULT_PAGE_SIZE)),
      `${tool.definition.name} does not state the default page size it will apply`,
    )
  }
})

test('annotations mark reads, updates, and deletes correctly', () => {
  assert.equal(definition('confetti_events_find').annotations.readOnlyHint, true)
  assert.equal(definition('confetti_events_find_all').annotations.readOnlyHint, true)
  assert.equal(definition('confetti_pages_delete').annotations.destructiveHint, true)
  assert.equal(definition('confetti_events_update').annotations.idempotentHint, true)
  assert.equal(definition('confetti_events_create').annotations.readOnlyHint, false)
})

test('exactly 10 tools are marked destructive', () => {
  const destructive = tools.filter((t) => t.definition.annotations.destructiveHint === true)
  assert.equal(destructive.length, 10)
})

test('update tools require only id, never the body schema required fields', () => {
  for (const tool of tools) {
    if (tool.operation !== 'update') continue
    assert.deepEqual(
      tool.definition.inputSchema.required,
      ['id'],
      `${tool.definition.name} must require only id`,
    )
  }
})

// --- audit rank 24: the partial-update promise, pinned against upstream drift ---

test('no upstream update schema has a required field', () => {
  // `updateSchema` advertises required:['id'] only. That promise holds exactly
  // as long as this is true upstream; the moment a bump makes a field
  // non-optional, the advertised schema starts lying and this test says so.
  const models = Confetti.models as unknown as Record<string, { operations: Record<string, unknown> }>
  const checked: string[] = []
  for (const { modelKey, operation } of listResourceOperations()) {
    if (operation !== 'update') continue
    const config = models[modelKey]?.operations['update'] as { schema: never } | undefined
    assert.ok(config, `models.${modelKey}.operations.update is missing`)
    const generated = schemaToJsonSchema(config.schema) as { required?: string[] }
    assert.deepEqual(
      generated.required ?? [],
      [],
      `models.${modelKey}.operations.update now has required fields — updateSchema's required:['id'] promise is broken`,
    )
    checked.push(modelKey)
  }
  assert.equal(checked.length, 11)
})

// --- audit rank 2: required filters are advertised ---

test('find_all tools advertise the filters upstream makes mandatory', () => {
  for (const name of [
    'confetti_tickets_find_all',
    'confetti_payments_find_all',
    'confetti_ticket_batches_find_all',
  ]) {
    const schema = definition(name).inputSchema
    assert.deepEqual(schema.required, ['filter'], `${name} must require filter`)
    const filter = schema.properties['filter'] as { required?: string[] }
    assert.deepEqual(filter.required, ['eventId'], `${name} must require filter.eventId`)
  }
})

test('a find_all with no mandatory filter advertises no required array', () => {
  const schema = definition('confetti_events_find_all').inputSchema
  assert.equal(schema.required, undefined)
  const filter = schema.properties['filter'] as { required?: string[] }
  assert.equal(filter.required, undefined)
})

// --- audit rank 3: array filter enums belong on items ---

test('filter.status carries its enum on items, so the schema is satisfiable', () => {
  for (const [name, value] of [
    ['confetti_tickets_find_all', 'attending'],
    ['confetti_payments_find_all', 'paid'],
  ] as const) {
    const status = nested(props(name)['filter']!)['status']
    assert.ok(status, `${name} should expose filter.status`)
    assert.equal(status['type'], 'array')
    assert.equal(status['enum'], undefined, 'an array-level enum can never be satisfied')
    const items = status['items'] as { type?: string; enum?: string[] }
    assert.equal(items.type, 'string')
    assert.ok(items.enum?.includes(value), `${name} lost its status values`)
  }
})

test('no array-typed schema anywhere carries a top-level enum', () => {
  const seen: string[] = []
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${path}[${index}]`))
      return
    }
    if (typeof node !== 'object' || node === null) return
    const record = node as Record<string, unknown>
    if (record['type'] === 'array' && record['enum'] !== undefined) seen.push(path)
    for (const [key, value] of Object.entries(record)) walk(value, `${path}.${key}`)
  }
  for (const tool of tools) walk(tool.definition.inputSchema, tool.definition.name)
  assert.deepEqual(seen, [])
})

// --- audit rank 15: single-typed id ---

test('id is advertised with a single type and documents that numbers work too', () => {
  let count = 0
  for (const tool of tools) {
    const id = tool.definition.inputSchema.properties['id'] as Record<string, unknown> | undefined
    if (!id) continue
    count += 1
    assert.equal(id['type'], 'string', `${tool.definition.name}.id must be single-typed`)
    assert.match(description(id), /number/i, `${tool.definition.name}.id must say numbers work`)
  }
  // find (18) + update (11) + delete (10). The audit says 41; it is 39.
  assert.equal(count, 39)
})

test('no schema in the surface uses a union type array', () => {
  const offenders = tools
    .filter((tool) => JSON.stringify(tool.definition.inputSchema).includes('"type":['))
    .map((tool) => tool.definition.name)
  assert.deepEqual(offenders, [])
})

// --- audit rank 16 / quality 9: human titles and a closed world ---

test('annotations carry a human title, not the machine name', () => {
  assert.equal(definition('confetti_events_find_all').annotations.title, 'List Events')
  assert.equal(definition('confetti_ticket_batches_find_all').annotations.title, 'List Ticket Batches')
  assert.equal(definition('confetti_sponsor_levels_delete').annotations.title, 'Delete Sponsor Level')
  assert.equal(definition('confetti_events_find').annotations.title, 'Get Event')
  assert.equal(definition('confetti_form_fields_update').annotations.title, 'Update Form Field')
  for (const tool of tools) {
    assert.notEqual(
      tool.definition.annotations.title,
      tool.definition.name,
      `${tool.definition.name} still shows its machine name as a title`,
    )
  }
})

test('every tool declares a closed world', () => {
  for (const tool of tools) {
    assert.equal(
      tool.definition.annotations.openWorldHint,
      false,
      `${tool.definition.name} must not claim an open world`,
    )
  }
})

// --- audit rank 26: generated schemas stay flat object schemas ---

test('no generated schema contains a $ref or a $defs block', () => {
  const serialised = JSON.stringify(tools.map((tool) => tool.definition))
  assert.doesNotMatch(serialised, /\$ref/)
  assert.doesNotMatch(serialised, /\$defs/)
})

test('every input schema is an object schema with properties', () => {
  for (const tool of tools) {
    assert.equal(tool.definition.inputSchema.type, 'object', tool.definition.name)
    assert.ok(
      Object.keys(tool.definition.inputSchema.properties).length > 0,
      `${tool.definition.name} has an empty property set`,
    )
  }
})

test('the schema sanity guard rejects anything that is not a flat object schema', () => {
  assert.throws(() => assertObjectSchema({ anyOf: [] }, 'previewToken.create'), /previewToken\.create/)
  assert.throws(() => assertObjectSchema({ type: 'object' }, 'event.create'), /event\.create/)
  assert.throws(() => assertObjectSchema({ type: 'object', properties: {} }, 'event.create'), /event\.create/)
  assert.throws(
    () => assertObjectSchema({ type: 'object', properties: { a: { $ref: '#/$defs/A' } } }, 'event.create'),
    /\$ref/,
  )
  assertObjectSchema({ type: 'object', properties: { a: { type: 'string' } } }, 'event.create')
})

// --- quality 3: one sample per resource, compact ---

test('the sample record is attached to find_all when there is one', () => {
  const findAll = definition('confetti_events_find_all').description
  assert.match(findAll, /Example record:/)
  assert.match(findAll, /startDate/)

  const find = definition('confetti_events_find').description
  assert.doesNotMatch(find, /Example record:/, 'the sample must not be shipped twice')
  assert.match(find, /confetti_events_find_all/, 'find must point at the shape it shares')
})

test('a resource with no find_all keeps its sample on find', () => {
  for (const name of [
    'confetti_speakers_find',
    'confetti_organisers_find',
    'confetti_schedule_items_find',
    'confetti_sponsors_find',
    'confetti_sponsor_levels_find',
    'confetti_forms_find',
    'confetti_form_fields_find',
  ]) {
    assert.match(definition(name).description, /Example record:/, `${name} lost its only sample`)
  }
})

test('samples ship compact, exactly once per resource', () => {
  const carriers = tools.filter((tool) => tool.definition.description.includes('Example record:'))
  assert.equal(carriers.length, 18, 'one sample per mapped resource, no duplicates')
  for (const tool of carriers) {
    const sample = tool.definition.description.split('Example record:')[1] ?? ''
    assert.doesNotMatch(sample, /\n/, `${tool.definition.name} pretty-prints its sample`)
  }
})

// --- quality 4: the stripped Zod meta comes back ---

test('stripped helpText and placeholder are recovered as descriptions', () => {
  const ticket = props('confetti_tickets_create')
  assert.match(description(ticket['sendEmailConfirmation']!), /email confirmation/i)
  assert.match(description(ticket['ticketBatchId']!), /Required for ticket events/)
  assert.match(description(props('confetti_contacts_create')['phone']!), /\+46701234567/)
})

test('recovered meta reads as sentences, not run-on fragments', () => {
  const batch = description(props('confetti_tickets_create')['ticketBatchId']!)
  assert.match(batch, /Required for ticket events\. Obtain from confetti_ticket_batches_find_all\./)
})

test('a placeholder is not repeated when the helpText already carries the example', () => {
  const phone = description(props('confetti_contacts_create')['phone']!)
  assert.equal(phone.match(/Example/g)?.length, 1, `phone says Example twice: ${phone}`)
})

test('meta recovery fills gaps only and never overwrites upstream prose', () => {
  const comment = description(props('confetti_tickets_create')['comment']!)
  assert.match(comment, /^Internal note visible only to workspace teammates/)
})

test('bare Title-Case label echoes are not shipped as descriptions', () => {
  const firstName = props('confetti_tickets_create')['firstName']!
  assert.equal(description(firstName), '', 'a "First name" echo is not documentation')
})

test('the stripped enum values come back on the bare string branch', () => {
  const status = props('confetti_tickets_create')['status']!
  const branches = status['anyOf'] as Array<Record<string, unknown>>
  const bare = branches.find((branch) => branch['type'] === 'string')
  assert.ok(bare)
  assert.deepEqual(bare['enum'], ['attending', 'invited'])
})

test('date unions collapse to one honest date-time property', () => {
  const startDate = props('confetti_events_create')['startDate']!
  assert.equal(startDate['anyOf'], undefined, 'the bare string branch made the format meaningless')
  assert.equal(startDate['type'], 'string')
  assert.equal(startDate['format'], 'date-time')
  assert.match(description(startDate), /date or date-time/i)
  assert.match(description(startDate), /2026-09-01/)
})

test('a nullable date keeps its null branch while losing the bare string branch', () => {
  const checkinAt = props('confetti_tickets_update')['checkinAt']!
  const branches = (checkinAt['anyOf'] as Array<Record<string, unknown>>) ?? []
  assert.deepEqual(
    branches.map((branch) => branch['type']),
    ['string', 'null'],
  )
  assert.equal(branches[0]?.['format'], 'date-time')
})

// --- quality 4/5: the formValues lie ---

test('ticket.values no longer points at a field that does not exist', () => {
  for (const name of ['confetti_tickets_create', 'confetti_tickets_update']) {
    const values = description(props(name)['values']!)
    assert.doesNotMatch(values, /formValues/, `${name}.values still advertises a phantom field`)
    assert.doesNotMatch(values, /prefer/i)
    assert.match(values, /field name/i)
    assert.match(values, /dietary-needs/)
  }
})

// --- quality 5: descriptions composed from registry data ---

test('create descriptions state the required fields and the parents', () => {
  const ticket = definition('confetti_tickets_create').description
  assert.match(ticket, /Required: eventId, email, status, sendEmailConfirmation\./)
  assert.match(ticket, /Belongs to:/)
  assert.match(ticket, /event \(eventId\)/)
  assert.match(ticket, /ticketBatch \(ticketBatchId\)/)
})

test('*Id properties say where the id comes from', () => {
  assert.match(description(props('confetti_tickets_create')['eventId']!), /confetti_events_find_all/)
  assert.match(
    description(props('confetti_blocks_create')['pageId']!),
    /confetti_pages_find_all/,
  )
  assert.match(
    description(props('confetti_sponsors_create')['sponsorLevelId']!),
    /confetti_sponsor_levels_create/,
    'no list tool and no include path: the create response is the only source',
  )
  assert.match(
    description(props('confetti_form_fields_create')['formId']!),
    /confetti_events_find/,
    'forms are only reachable through an event include',
  )
})

test('an *Id whose prefix names no resource is left alone', () => {
  // blockStyle, theme and section are not resources here: a cross-link would be
  // an invented tool name, so the pass must skip them.
  for (const [tool, field] of [
    ['confetti_blocks_create', 'blockStyleId'],
    ['confetti_images_create', 'themeId'],
    ['confetti_form_fields_create', 'sectionId'],
  ] as const) {
    assert.doesNotMatch(description(props(tool)[field]!), /Obtain/, `${tool}.${field}`)
  }
})

test('required filters are cross-linked too', () => {
  const eventId = nested(props('confetti_tickets_find_all')['filter']!)['eventId']!
  assert.match(description(eventId), /confetti_events_find_all/)
})

test('the seven list-less resources tell the model how to enumerate them', () => {
  const speaker = definition('confetti_speakers_find').description
  assert.match(speaker, /no list tool/i)
  assert.match(speaker, /confetti_events_find/)
  assert.match(speaker, /include/)
  assert.match(speaker, /"speakers"/)

  const sponsor = definition('confetti_sponsors_update').description
  assert.match(sponsor, /no list tool/i)
  assert.match(sponsor, /confetti_sponsors_create/, 'the honest fallback: keep the created id')
})

test('every tool of a list-less resource carries the breadcrumb', () => {
  const listless = new Set([
    'form',
    'formField',
    'speaker',
    'organiser',
    'scheduleItem',
    'sponsor',
    'sponsorLevel',
  ])
  for (const tool of tools) {
    if (!listless.has(tool.modelKey)) continue
    assert.match(
      tool.definition.description,
      /no list tool/i,
      `${tool.definition.name} leaves the model hunting for a find_all`,
    )
  }
})

test('cross-tool notes reach the tools that need them', () => {
  assert.match(definition('confetti_events_update').description, /cancelled/)
  assert.match(definition('confetti_tickets_create').description, /ticketBatchId/)
  assert.match(definition('confetti_payments_find_all').description, /read-only/i)
  assert.match(definition('confetti_ticket_batches_find').description, /read-only/i)
})

test('update descriptions promise only what the request actually does', () => {
  // The old text promised "Only the fields you pass are changed" — a claim about
  // server semantics this server cannot make (`resources.js` sends PUT).
  for (const tool of tools) {
    if (tool.operation !== 'update') continue
    assert.doesNotMatch(tool.definition.description, /Only the fields you pass are changed/)
  }
  assert.match(definition('confetti_events_update').description, /fields you want to change/)
})

test('the tool surface stays inside its context budget', () => {
  // Accounting against the 67,926 bytes this surface shipped at v0.1.0:
  // deduplicating the samples took 12,524 bytes of duplicated examples down to
  // 6,353, and the ~9KB that bought went into documentation a model previously
  // had to discover by failing — recovered helpText, enum values, id
  // cross-links, required fields, and the list-less breadcrumbs. The ceiling is
  // here so that stays a deliberate trade and not a drift.
  //
  // Raised once since, from 72,000, for +2,268 bytes: `webhook.type` is a bare
  // string upstream, so its 17 valid event types are now generated from the
  // registry's own webhook configs (a model could otherwise only guess), and
  // ten fields whose meaning is readable from neither the schema nor the name
  // gained descriptions — the free-form `settings`/`content` objects and the
  // block-style/theme ids no tool lists. Those descriptions say plainly where
  // upstream documents nothing, instead of guessing; wording is shared between
  // resources so each fact costs its bytes once. Three weaker entries were cut
  // to pay for it.
  const bytes = JSON.stringify(tools.map((tool) => tool.definition)).length
  assert.ok(bytes < 74_500, `tool surface grew to ${bytes} bytes`)

  const samples = tools.reduce((total, tool) => {
    const index = tool.definition.description.indexOf('Example record:')
    return index < 0 ? total : total + tool.definition.description.length - index
  }, 0)
  assert.ok(samples < 7_000, `samples cost ${samples} bytes, down from 12,524`)
})
