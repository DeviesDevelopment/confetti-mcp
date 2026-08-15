import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import nock from 'nock'
import { buildTools } from '../../src/tools/definitions.js'
import { callTool, DEFAULT_PAGE_SIZE } from '../../src/tools/dispatch.js'

const API = 'https://api.confetti.events'
const tools = new Map(buildTools().map((t) => [t.definition.name, t]))
const context = { apiKey: 'sk_test_key' }

function tool(name: string) {
  const found = tools.get(name)
  assert.ok(found, `${name} not generated`)
  return found
}

afterEach(() => {
  nock.cleanAll()
})

test('find_all sends the api key as an apikey Authorization header', async () => {
  const scope = nock(API, { reqheaders: { authorization: 'apikey sk_test_key' } })
    .get('/events')
    .query(true)
    .reply(200, { data: [] }, { 'content-type': 'application/json' })

  await callTool(tool('confetti_events_find_all'), {}, context)
  scope.done()
})

test('find_all applies the default page size', async () => {
  const scope = nock(API)
    .get('/events')
    .query((q) => q['page[size]'] === String(DEFAULT_PAGE_SIZE))
    .reply(200, { data: [] }, { 'content-type': 'application/json' })

  await callTool(tool('confetti_events_find_all'), {}, context)
  scope.done()
})

test('an explicit page size overrides the default', async () => {
  const scope = nock(API)
    .get('/events')
    .query((q) => q['page[size]'] === '100')
    .reply(200, { data: [] }, { 'content-type': 'application/json' })

  await callTool(tool('confetti_events_find_all'), { page: { size: 100 } }, context)
  scope.done()
})

test('find_all forwards filters', async () => {
  const scope = nock(API)
    .get('/events')
    .query((q) => q['filter[signupType]'] === 'rsvp')
    .reply(200, { data: [] }, { 'content-type': 'application/json' })

  await callTool(tool('confetti_events_find_all'), { filter: { signupType: 'rsvp' } }, context)
  scope.done()
})

test('find requests the record by id', async () => {
  const scope = nock(API)
    .get('/events/42')
    .query(true)
    .reply(200, { data: { id: '42', type: 'events', attributes: { name: 'Kickoff' } } }, {
      'content-type': 'application/json',
    })

  const result = (await callTool(tool('confetti_events_find'), { id: 42 }, context)) as { name?: string }
  assert.equal(result.name, 'Kickoff')
  scope.done()
})

test('create posts the whole argument object as the body', async () => {
  const scope = nock(API)
    .post('/events', (body) => body.data.attributes.name === 'Launch')
    .reply(200, { data: { id: '1', type: 'events', attributes: { name: 'Launch' } } }, {
      'content-type': 'application/json',
    })

  await callTool(
    tool('confetti_events_create'),
    { name: 'Launch', startDate: '2026-09-01T10:00:00.000Z' },
    context,
  )
  scope.done()
})

test('update splits id from the body', async () => {
  const scope = nock(API)
    .put('/events/7', (body) => body.data.attributes.name === 'Renamed')
    .reply(200, { data: { id: '7', type: 'events', attributes: { name: 'Renamed' } } }, {
      'content-type': 'application/json',
    })

  await callTool(tool('confetti_events_update'), { id: 7, name: 'Renamed' }, context)
  scope.done()
})

test('delete requests the record by id', async () => {
  const scope = nock(API).delete('/pages/3').query(true).reply(204, '')
  await callTool(tool('confetti_pages_delete'), { id: 3 }, context)
  scope.done()
})

test('a missing id is rejected before the request goes out', async () => {
  await assert.rejects(() => callTool(tool('confetti_events_find'), {}, context), /id is required/)
})

test('upstream 404 propagates as NotFoundError', async () => {
  nock(API)
    .get('/events/999')
    .query(true)
    .reply(404, { message: 'Event not found' }, { 'content-type': 'application/json' })

  await assert.rejects(
    () => callTool(tool('confetti_events_find'), { id: 999 }, context),
    (error: Error) => {
      assert.equal(error.name, 'NotFoundError')
      return true
    },
  )
})
