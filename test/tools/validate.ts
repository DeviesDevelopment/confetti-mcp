import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTools } from '../../src/tools/definitions.js'
import { validateArgs } from '../../src/tools/validate.js'

const tools = new Map(buildTools().map((t) => [t.definition.name, t]))

function tool(name: string) {
  const found = tools.get(name)
  assert.ok(found, `${name} not generated`)
  return found
}

function rejection(name: string, args: Record<string, unknown>): Error {
  try {
    validateArgs(tool(name), args)
  } catch (error) {
    assert.ok(error instanceof Error)
    assert.equal(error.name, 'ParameterError')
    return error
  }
  assert.fail(`${name} accepted ${JSON.stringify(args)}`)
}

test('an unknown top-level field is rejected, listing the valid fields', () => {
  // Upstream Zod strips unknown keys, so this used to send an empty PUT and
  // return success — a failure the model can never detect.
  const error = rejection('confetti_events_update', { id: 5, titel: 'New Name' })
  assert.match(error.message, /titel/)
  assert.match(error.message, /confetti_events_update/)
  assert.match(error.message, /\bname\b/, 'the valid fields must be listed')
})

test('a near-miss field name gets a correction', () => {
  const error = rejection('confetti_events_update', { id: 5, nmae: 'New Name' })
  assert.match(error.message, /Did you mean "name"\?/)
})

test('valid arguments are accepted for every operation shape', () => {
  validateArgs(tool('confetti_events_find_all'), {
    filter: { signupType: 'rsvp' },
    include: ['categories'],
    page: { number: 2, size: 10 },
  })
  validateArgs(tool('confetti_events_find'), { id: 42, include: ['pages'] })
  validateArgs(tool('confetti_events_create'), {
    name: 'Launch',
    startDate: '2026-09-01T10:00:00.000Z',
  })
  validateArgs(tool('confetti_events_update'), { id: 7, name: 'Renamed' })
  validateArgs(tool('confetti_pages_delete'), { id: 3 })
})

test('connection option keys are ignored rather than rejected', () => {
  // They are stripped by the dispatch allowlist and the regression tests pin
  // that such a call still reaches the real host with the trusted key.
  validateArgs(tool('confetti_events_find_all'), {
    apiKey: 'ATTACKER_KEY',
    apiHost: 'evil.example.com',
    apiProtocol: 'http',
    raw: true,
  })
})

test('an unknown key inside a declared nested object is rejected', () => {
  const error = rejection('confetti_tickets_find_all', { filter: { eventid: 5 } })
  assert.match(error.message, /filter\.eventid/)
  assert.match(error.message, /eventId/)
})

test('free-form objects are not recursed into', () => {
  // block.content and ticket.values are looseObject upstream: any key is legal.
  validateArgs(tool('confetti_blocks_create'), {
    type: 'text',
    status: 'published',
    content: { html: '<p>hi</p>', anythingAtAll: { nested: true } },
  })
  validateArgs(tool('confetti_tickets_create'), {
    eventId: 1,
    email: 'a@b.com',
    status: 'attending',
    sendEmailConfirmation: false,
    values: { 'dietary-needs': 'Vegan', whatever: 1 },
  })
})

test('advertised enums are enforced with the valid values in the message', () => {
  const sort = rejection('confetti_tickets_find_all', { sort: 'nmae' })
  assert.match(sort.message, /nmae/)
  assert.match(sort.message, /createdAt/, 'valid sort values must be listed')

  const include = rejection('confetti_events_find_all', { include: ['nope'] })
  assert.match(include.message, /nope/)
  assert.match(include.message, /categories/)

  const filter = rejection('confetti_events_find_all', { filter: { signupType: 'raffle' } })
  assert.match(filter.message, /raffle/)
  assert.match(filter.message, /rsvp/)

  const blockType = rejection('confetti_blocks_create', { type: 'txt', status: 'published' })
  assert.match(blockType.message, /txt/)
  assert.match(blockType.message, /header/)
})

test('an array value is checked against its item enum, not the array-level enum', () => {
  // filter.status ships its enum on the array rather than on items (a known
  // schema defect). Enforcing the array-level enum would reject every legal
  // value; item-level enforcement is correct under both spellings.
  validateArgs(tool('confetti_tickets_find_all'), { filter: { status: ['attending'] } })
})

test('an update with nothing but an id is rejected', () => {
  const error = rejection('confetti_events_update', { id: 5 })
  assert.match(error.message, /confetti_events_update/)
  assert.match(error.message, /no updatable fields|besides id/)
})

test('a non-ISO date is rejected with the correction in the message', () => {
  const error = rejection('confetti_events_create', { name: 'X', startDate: 'next friday' })
  assert.match(error.message, /startDate/)
  assert.match(error.message, /next friday/)
  assert.match(error.message, /ISO 8601/)
  assert.match(error.message, /2026-09-01/)
})

test('plain dates and full timestamps are both accepted', () => {
  for (const startDate of [
    '2026-09-01',
    '2026-09-01T18:00:00Z',
    '2026-09-01T18:00:00.000Z',
    '2026-09-01T18:00:00+02:00',
  ]) {
    validateArgs(tool('confetti_events_create'), { name: 'X', startDate })
  }
})

test('validation is generic: it never names a tool or model in its own source', async () => {
  const source = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../../src/tools/validate.ts', import.meta.url), 'utf8'),
  )
  assert.doesNotMatch(source, /confetti_/, 'no per-tool special cases')
})
