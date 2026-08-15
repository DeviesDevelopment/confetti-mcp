import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { shapeList, shapeRecord, shapeDeleted, shapeOk } from '../../src/tools/shape.js'

function manifest(path: string): { version?: string; dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as {
    version?: string
    dependencies?: Record<string, string>
  }
}

const listBody = {
  data: [
    { id: '1', type: 'events', attributes: { name: 'Kickoff' } },
    { id: '2', type: 'events', attributes: { name: 'Launch' } },
  ],
  meta: { total: 137 },
  links: { next: 'https://api.confetti.events/events?page[number]=2' },
}

test('a list is wrapped in an envelope that reports pagination', () => {
  const envelope = shapeList(listBody, { number: 1, size: 2 })

  assert.equal(envelope.returned, 2)
  assert.deepEqual(envelope.page, { number: 1, size: 2 })
  assert.equal(envelope.more, 'yes')
  assert.equal(envelope.total, 137)
  assert.equal(envelope.records.length, 2)
  assert.equal((envelope.records[0] as { name: string }).name, 'Kickoff')
})

test('an empty page is unambiguous rather than a bare []', () => {
  const envelope = shapeList({ data: [] }, { number: 1, size: 25 })

  assert.deepEqual(envelope.records, [])
  assert.equal(envelope.returned, 0)
  assert.equal(envelope.more, 'no')
})

test('without links, a full page is reported as likely-more and a short page as no', () => {
  const full = shapeList(
    { data: [{ id: '1', type: 'events', attributes: {} }] },
    { number: 1, size: 1 },
  )
  assert.equal(full.more, 'likely')

  const short = shapeList(
    { data: [{ id: '1', type: 'events', attributes: {} }] },
    { number: 1, size: 25 },
  )
  assert.equal(short.more, 'no')
})

test('links without a next member mean there is no more', () => {
  const envelope = shapeList(
    { data: [{ id: '1', type: 'events', attributes: {} }], links: { self: '/events' } },
    { number: 1, size: 1 },
  )
  assert.equal(envelope.more, 'no')
})

test('included relationships are resolved within the same call', () => {
  const envelope = shapeList(
    {
      data: [
        {
          id: '1',
          type: 'events',
          attributes: { name: 'Kickoff' },
          relationships: { workspace: { data: { id: '5', type: 'workspaces' } } },
        },
      ],
      included: [{ id: '5', type: 'workspaces', attributes: { name: 'Tenant A' } }],
    },
    { number: 1, size: 25 },
  )

  const record = envelope.records[0] as { workspace: { name: string } }
  assert.equal(record.workspace.name, 'Tenant A')
})

test('records never carry over between calls', () => {
  // The adapter's module-level yayson Store resolved relationship references
  // from records synced by ANY earlier request in the process, which on a
  // multi-tenant deployment splices one tenant's record into another's
  // response. Each shaping call must use its own Store.
  shapeRecord({
    data: {
      id: '1',
      type: 'events',
      attributes: { name: 'A event' },
      relationships: { workspace: { data: { id: '5', type: 'workspaces' } } },
    },
    included: [
      { id: '5', type: 'workspaces', attributes: { name: 'Tenant A', secret: 'A-only-data' } },
    ],
  })

  const second = shapeRecord({
    data: {
      id: '2',
      type: 'events',
      attributes: { name: 'B event' },
      relationships: { workspace: { data: { id: '5', type: 'workspaces' } } },
    },
  })

  const serialised = JSON.stringify(second)
  assert.doesNotMatch(serialised, /Tenant A/, "another call's record must not bleed in")
  assert.doesNotMatch(serialised, /A-only-data/)
})

test('a single record is flattened, not enveloped', () => {
  const record = shapeRecord({
    data: { id: '42', type: 'events', attributes: { name: 'Kickoff' } },
  }) as { id: string; name: string }

  assert.equal(record.name, 'Kickoff')
  assert.equal(record.id, '42')
})

test('a body that is not a JSON:API document yields no record', () => {
  assert.equal(shapeRecord(''), undefined)
  assert.equal(shapeRecord('OK'), undefined)
  assert.equal(shapeRecord(undefined), undefined)
})

test('a delete is confirmed explicitly', () => {
  assert.deepEqual(shapeDeleted('webhook', '91'), { deleted: true, resource: 'webhook', id: '91' })
})

test('any other empty-body success is confirmed explicitly', () => {
  assert.deepEqual(shapeOk('update', 'event', '7'), {
    ok: true,
    operation: 'update',
    resource: 'event',
    id: '7',
  })
  assert.deepEqual(shapeOk('create', 'event'), { ok: true, operation: 'create', resource: 'event' })
})

test('yayson is a direct dependency pinned to the version confetti resolves', () => {
  const ours = manifest('../../package.json').dependencies ?? {}
  const theirs = manifest('../../node_modules/confetti/package.json').dependencies ?? {}
  const installed = manifest('../../node_modules/yayson/package.json').version

  assert.ok(ours['yayson'], 'yayson must be declared, not relied on transitively')
  assert.equal(
    ours['yayson'],
    theirs['yayson'],
    'a second yayson copy would mean two Stores and two record shapes',
  )
  assert.equal(ours['yayson'], installed, 'the pin must be exact')
})
