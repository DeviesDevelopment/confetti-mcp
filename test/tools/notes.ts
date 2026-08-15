import { test } from 'node:test'
import assert from 'node:assert/strict'
import Confetti, { schemaToJsonSchema } from 'confetti'
import { FIELD_DESCRIPTIONS, NOTES, fieldDescription, notesFor } from '../../src/tools/notes.js'
import {
  OPERATIONS,
  RESOURCE_MAP,
  listResourceOperations,
  type ModelKey,
  type Operation,
} from '../../src/confetti/resource-map.js'

const live = new Map<string, Set<string>>()
for (const { modelKey, operation } of listResourceOperations()) {
  const set = live.get(modelKey) ?? new Set<string>()
  set.add(operation)
  live.set(modelKey, set)
}

function bodyProperties(modelKey: string): Set<string> {
  const models = Confetti.models as unknown as Record<
    string,
    { operations: Record<string, { schema: never } | undefined> }
  >
  const fields = new Set<string>()
  for (const operation of ['create', 'update']) {
    const config = models[modelKey]?.operations[operation]
    if (!config) continue
    const generated = schemaToJsonSchema(config.schema) as { properties?: Record<string, unknown> }
    for (const field of Object.keys(generated.properties ?? {})) fields.add(field)
  }
  return fields
}

test('every note is keyed to a resource that still exists', () => {
  for (const modelKey of Object.keys(NOTES)) {
    assert.ok(modelKey in RESOURCE_MAP, `NOTES.${modelKey} names no mapped resource`)
    assert.ok(live.has(modelKey), `NOTES.${modelKey} has no operations at all`)
  }
})

test('every note is keyed to an operation that still exists', () => {
  for (const [modelKey, entry] of Object.entries(NOTES)) {
    for (const scope of Object.keys(entry ?? {})) {
      if (scope === 'all') continue
      assert.ok(
        (OPERATIONS as readonly string[]).includes(scope),
        `NOTES.${modelKey}.${scope} is not an operation`,
      )
      assert.ok(
        live.get(modelKey)?.has(scope),
        `NOTES.${modelKey}.${scope} would never be shown — that operation does not exist`,
      )
    }
  }
})

test('the table stays a short table, not a documentation site', () => {
  const entries = Object.values(NOTES).flatMap((entry) => Object.values(entry ?? {}))
  assert.ok(entries.length > 0)
  assert.ok(entries.length <= 18, `${entries.length} notes — this table must stay small`)
  for (const note of entries) {
    assert.ok(note.length <= 300, `a note is ${note.length} chars: ${note.slice(0, 40)}…`)
    assert.match(note, /\.$/, 'notes are sentences')
  }
})

test('notesFor emits the resource-wide note before the operation note', () => {
  const notes = notesFor('ticket', 'create')
  assert.equal(notes.length, 2)
  assert.equal(notes[0], NOTES.ticket?.all)
  assert.equal(notes[1], NOTES.ticket?.create)
  assert.deepEqual(notesFor('page', 'create'), [], 'no note is not an error')
})

test('every note names only tools that are actually generated', () => {
  const generated = new Set(
    listResourceOperations().map(({ resourceName, operation }) => ({ resourceName, operation })),
  )
  assert.ok(generated.size > 0)
  const names = new Set(
    listResourceOperations().map(
      ({ resourceName, operation }) =>
        `confetti_${resourceName.replace(/([A-Z])/g, '_$1').toLowerCase()}_${operation.replace(/([A-Z])/g, '_$1').toLowerCase()}`,
    ),
  )
  const referenced = [...Object.values(NOTES), ...Object.values(FIELD_DESCRIPTIONS)]
    .flatMap((entry) => Object.values(entry ?? {}))
    .flatMap((text) => text.match(/confetti_[a-z_]+/g) ?? [])
  assert.ok(referenced.length > 0, 'the tables should cross-reference tools')
  for (const name of referenced) {
    const bare = name.replace(/_\*$/, '')
    assert.ok(
      names.has(bare) || [...names].some((candidate) => candidate.startsWith(bare)),
      `${name} is referenced but no such tool is generated`,
    )
  }
})

test('every field override names a field that still exists', () => {
  for (const [modelKey, fields] of Object.entries(FIELD_DESCRIPTIONS)) {
    assert.ok(modelKey in RESOURCE_MAP, `FIELD_DESCRIPTIONS.${modelKey} names no mapped resource`)
    const properties = bodyProperties(modelKey)
    for (const field of Object.keys(fields ?? {})) {
      assert.ok(
        properties.has(field),
        `FIELD_DESCRIPTIONS.${modelKey}.${field} overrides a field that no longer exists`,
      )
    }
  }
})

test('the ticket.values override replaces the phantom formValues advice', () => {
  const override = fieldDescription('ticket', 'values')
  assert.ok(override, 'the upstream text must not be shipped as-is')
  assert.doesNotMatch(override, /formValues/)
  assert.equal(fieldDescription('event', 'name'), undefined, 'overrides stay the exception')
})

test('the upstream description this override exists for is still wrong', () => {
  // The day upstream fixes it, this fails and the override can go. `formValues`
  // appears nowhere in the package except inside this one description.
  const models = Confetti.models as unknown as Record<
    string,
    { operations: Record<string, { schema: never }> }
  >
  const generated = schemaToJsonSchema(models['ticket']!.operations['create']!.schema) as {
    properties: Record<string, { description?: string }>
  }
  assert.match(
    generated.properties['values']?.description ?? '',
    /formValues/,
    'upstream no longer advertises formValues — delete the override',
  )
})

test('a note is only claimed for resources whose operations support it', () => {
  // "read-only through the API" must never be said about a resource that has
  // write tools generated for it.
  for (const [modelKey, entry] of Object.entries(NOTES)) {
    const text = Object.values(entry ?? {}).join(' ')
    if (!/read-only through the API/.test(text)) continue
    for (const operation of ['create', 'update', 'delete'] as Operation[]) {
      assert.ok(
        live.get(modelKey)?.has(operation) !== true,
        `NOTES.${modelKey} calls the resource read-only but ${operation} exists`,
      )
    }
  }
})

test('resources with no write operations say so', () => {
  const readOnly = (Object.keys(RESOURCE_MAP) as ModelKey[]).filter((modelKey) => {
    const operations = live.get(modelKey)
    return operations !== undefined && !['create', 'update', 'delete'].some((o) => operations.has(o))
  })
  assert.deepEqual(readOnly, ['payment', 'workspace', 'category', 'ticketBatch', 'form'])
  for (const modelKey of readOnly) {
    const text = Object.values(NOTES[modelKey] ?? {}).join(' ')
    assert.match(text, /read-only/i, `${modelKey} has no write tools and should say so`)
  }
})
