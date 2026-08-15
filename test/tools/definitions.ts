import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTools } from '../../src/tools/definitions.js'

const tools = buildTools()
const byName = new Map(tools.map((t) => [t.definition.name, t]))

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
  const tool = byName.get('confetti_events_create')
  assert.ok(tool)
  const props = tool.definition.inputSchema.properties
  assert.ok('name' in props)
  assert.ok('startDate' in props)
  assert.ok('workspaceId' in props, 'workspaceId must NOT be stripped')
  assert.deepEqual(tool.definition.inputSchema.required, ['name', 'startDate'])
})

test('events_update requires id alongside the update fields', () => {
  const tool = byName.get('confetti_events_update')
  assert.ok(tool)
  assert.ok('id' in tool.definition.inputSchema.properties)
  assert.ok(tool.definition.inputSchema.required?.includes('id'))
})

test('tickets_find_all exposes a sort enum because ticket has sorting', () => {
  const tool = byName.get('confetti_tickets_find_all')
  assert.ok(tool)
  const sort = tool.definition.inputSchema.properties['sort'] as { enum?: string[] } | undefined
  assert.ok(sort, 'tickets should expose sort')
  assert.ok(sort.enum?.includes('createdAt'))
})

test('events_find_all omits sort because event has no sorting', () => {
  const tool = byName.get('confetti_events_find_all')
  assert.ok(tool)
  assert.equal(tool.definition.inputSchema.properties['sort'], undefined)
})

test('events_find_all exposes filter and include', () => {
  const tool = byName.get('confetti_events_find_all')
  assert.ok(tool)
  const filter = tool.definition.inputSchema.properties['filter'] as
    | { properties?: Record<string, { enum?: string[] }> }
    | undefined
  assert.ok(filter?.properties?.['signupType'])
  assert.deepEqual(filter.properties['signupType'].enum, ['rsvp', 'tickets'])

  const include = tool.definition.inputSchema.properties['include'] as
    | { items?: { enum?: string[] } }
    | undefined
  assert.ok(include?.items?.enum?.includes('categories'))
})

test('contacts_find_all omits filter because contact has no filters', () => {
  const tool = byName.get('confetti_contacts_find_all')
  assert.ok(tool)
  assert.equal(tool.definition.inputSchema.properties['filter'], undefined)
})

test('find and delete tools take id', () => {
  for (const name of ['confetti_forms_find', 'confetti_pages_delete']) {
    const tool = byName.get(name)
    assert.ok(tool, `${name} missing`)
    assert.ok('id' in tool.definition.inputSchema.properties)
    assert.deepEqual(tool.definition.inputSchema.required, ['id'])
  }
})

test('every find_all exposes page', () => {
  for (const tool of tools) {
    if (tool.operation !== 'findAll') continue
    assert.ok('page' in tool.definition.inputSchema.properties, `${tool.definition.name} lacks page`)
  }
})

test('annotations mark reads, updates, and deletes correctly', () => {
  assert.equal(byName.get('confetti_events_find')?.definition.annotations.readOnlyHint, true)
  assert.equal(byName.get('confetti_events_find_all')?.definition.annotations.readOnlyHint, true)
  assert.equal(byName.get('confetti_pages_delete')?.definition.annotations.destructiveHint, true)
  assert.equal(byName.get('confetti_events_update')?.definition.annotations.idempotentHint, true)
  assert.equal(byName.get('confetti_events_create')?.definition.annotations.readOnlyHint, false)
})

test('exactly 10 tools are marked destructive', () => {
  const destructive = tools.filter((t) => t.definition.annotations.destructiveHint === true)
  assert.equal(destructive.length, 10)
})

test('descriptions embed a sample payload for read tools', () => {
  const tool = byName.get('confetti_events_find')
  assert.ok(tool)
  assert.match(tool.definition.description, /Example/)
  assert.match(tool.definition.description, /startDate/)
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
