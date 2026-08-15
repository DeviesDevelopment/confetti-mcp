import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import nock from 'nock'
import { buildTools } from '../../src/tools/definitions.js'
import {
  callTool,
  callerOptions,
  DEFAULT_PAGE_SIZE,
  DEFAULT_TIMEOUT_MS,
  MAX_PAGE_SIZE,
} from '../../src/tools/dispatch.js'

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

test('a non-object page is rejected instead of silently returning page 1', async () => {
  // The worst pagination failure mode: the model asks for page 2 and gets
  // page 1 with no signal, so it loops re-fetching the same records.
  const scope = nock(API).get('/events').query(true).reply(200, { data: [] }, {
    'content-type': 'application/json',
  })

  for (const page of [2, '2', 'second', [], null]) {
    await assert.rejects(
      () => callTool(tool('confetti_events_find_all'), { page }, context),
      (error: Error) => {
        assert.equal(error.name, 'ParameterError')
        assert.match(error.message, /page/)
        return true
      },
      `page ${JSON.stringify(page)} must be rejected`,
    )
  }

  assert.equal(scope.isDone(), false, 'a malformed page must not reach the API')
})

test('an oversized page size is clamped', async () => {
  const scope = nock(API)
    .get('/events')
    .query((q) => q['page[size]'] === String(MAX_PAGE_SIZE))
    .reply(200, { data: [] }, { 'content-type': 'application/json' })

  await callTool(tool('confetti_events_find_all'), { page: { size: 1000000 } }, context)
  scope.done()
})

test('an oversized page limit is clamped', async () => {
  const scope = nock(API)
    .get('/events')
    .query((q) => q['page[limit]'] === String(MAX_PAGE_SIZE))
    .reply(200, { data: [] }, { 'content-type': 'application/json' })

  await callTool(tool('confetti_events_find_all'), { page: { limit: 1000000 } }, context)
  scope.done()
})

test('a page number and size within bounds pass through untouched', async () => {
  const scope = nock(API)
    .get('/events')
    .query((q) => q['page[number]'] === '3' && q['page[size]'] === '10')
    .reply(200, { data: [] }, { 'content-type': 'application/json' })

  await callTool(tool('confetti_events_find_all'), { page: { number: 3, size: 10 } }, context)
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

test('an unknown field is rejected before the request goes out', async () => {
  // Upstream Zod strips it, so this used to send an empty PUT and report
  // success — the silent no-op a model can never detect.
  const scope = nock(API)
    .put('/events/5')
    .reply(200, { data: { id: '5', type: 'events', attributes: {} } }, {
      'content-type': 'application/json',
    })

  await assert.rejects(
    () => callTool(tool('confetti_events_update'), { id: 5, titel: 'New Name' }, context),
    /titel/,
  )
  assert.equal(scope.isDone(), false, 'nothing may be sent for an unknown field')
})

test('a missing id is rejected before the request goes out', async () => {
  await assert.rejects(() => callTool(tool('confetti_events_find'), {}, context), /id is required/)
})

test('a traversal id cannot reach another resource', async () => {
  // Reproduces the verified bypass: a connection scoped ?resources=events
  // called confetti_events_find with '../payments/7' and got the payment back,
  // because WHATWG URL parsing collapses the dot segment before the request.
  const traversed = nock(API)
    .get('/payments/7')
    .query(true)
    .reply(200, { data: { id: '7', type: 'payments', attributes: { amount: 100 } } }, {
      'content-type': 'application/json',
    })

  await assert.rejects(
    () => callTool(tool('confetti_events_find'), { id: '../payments/7' }, context),
    (error: Error) => {
      assert.equal(error.name, 'ParameterError')
      assert.match(error.message, /id/)
      return true
    },
  )

  assert.equal(traversed.isDone(), false, 'no request may leave for the traversed path')
})

test('a traversal id cannot delete another resource', async () => {
  const traversed = nock(API).delete('/webhooks/9').query(true).reply(204, '')

  await assert.rejects(
    () => callTool(tool('confetti_pages_delete'), { id: '../webhooks/9' }, context),
    (error: Error) => {
      assert.equal(error.name, 'ParameterError')
      return true
    },
  )

  assert.equal(traversed.isDone(), false, 'a scoped connection must not reach another resource')
})

test('an empty or whitespace id is rejected instead of hitting the collection route', async () => {
  const collection = nock(API).get('/events/').query(true).reply(200, { data: [] }, {
    'content-type': 'application/json',
  })

  for (const id of ['', '   ']) {
    await assert.rejects(
      () => callTool(tool('confetti_events_find'), { id }, context),
      (error: Error) => {
        assert.equal(error.name, 'ParameterError')
        return true
      },
    )
  }

  assert.equal(collection.isDone(), false)
})

test('ids with query or fragment characters are rejected', async () => {
  for (const id of ['7?x=1', '7#frag', '..%2Fpayments%2F7', 'a b']) {
    await assert.rejects(
      () => callTool(tool('confetti_events_find'), { id }, context),
      (error: Error) => {
        assert.equal(error.name, 'ParameterError')
        return true
      },
      `id ${JSON.stringify(id)} must be rejected`,
    )
  }
})

test('ordinary numeric and hashid ids still pass', async () => {
  const scope = nock(API)
    .get('/events/aB3-x_9')
    .query(true)
    .reply(200, { data: { id: 'aB3-x_9', type: 'events', attributes: { name: 'Hashid' } } }, {
      'content-type': 'application/json',
    })

  await callTool(tool('confetti_events_find'), { id: 'aB3-x_9' }, context)
  scope.done()
})

test('a hung upstream call is abandoned at the deadline', async () => {
  // confetti passes `timeout` to node-fetch v3, which ignores it, so nothing
  // upstream bounds this call: verified STILL HANGING after 8s against a
  // blackhole. The deadline has to live here.
  nock(API)
    .get('/events')
    .query(true)
    .delay(2000)
    .reply(200, { data: [] }, { 'content-type': 'application/json' })

  const started = Date.now()
  await assert.rejects(
    () => callTool(tool('confetti_events_find_all'), {}, { ...context, timeoutMs: 40 }),
    (error: Error) => {
      assert.equal(error.name, 'ParameterError')
      assert.match(error.message, /40 ?ms/, 'the message must name the limit that fired')
      return true
    },
  )
  assert.ok(Date.now() - started < 1000, 'the call must be abandoned at the deadline, not later')
})

test('the default deadline is a finite number of milliseconds', () => {
  assert.equal(typeof DEFAULT_TIMEOUT_MS, 'number')
  assert.ok(DEFAULT_TIMEOUT_MS > 0 && Number.isFinite(DEFAULT_TIMEOUT_MS))
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

test('find_all arguments cannot redirect the request to another host', async () => {
  const legit = nock(API, { reqheaders: { authorization: 'apikey sk_test_key' } })
    .get('/events')
    .query(true)
    .reply(200, { data: [] }, { 'content-type': 'application/json' })
  const evil = nock('http://evil.example.com').get('/events').query(true).reply(200, { data: [] })

  // Context deliberately omits apiHost/apiProtocol — CallContext permits it.
  await callTool(
    tool('confetti_events_find_all'),
    { apiKey: 'ATTACKER_KEY', apiHost: 'evil.example.com', apiProtocol: 'http' },
    { apiKey: 'sk_test_key' },
  )

  assert.ok(legit.isDone(), 'must reach the real host with the trusted key')
  assert.equal(evil.isDone(), false, 'tool arguments must not redirect the upstream request')
})

test('find arguments cannot redirect the request to another host', async () => {
  const legit = nock(API, { reqheaders: { authorization: 'apikey sk_test_key' } })
    .get('/events/1')
    .query(true)
    .reply(200, { data: { id: '1', type: 'events', attributes: {} } }, { 'content-type': 'application/json' })
  const evil = nock('http://evil.example.com').get('/events/1').query(true).reply(200, {})

  await callTool(
    tool('confetti_events_find'),
    { id: 1, apiKey: 'ATTACKER_KEY', apiHost: 'evil.example.com', apiProtocol: 'http' },
    { apiKey: 'sk_test_key' },
  )

  assert.ok(legit.isDone())
  assert.equal(evil.isDone(), false)
})

test('caller options are an allowlist, so an unknown upstream option key is inert', () => {
  // A denylist of today's connection keys fails open the moment `confetti`
  // adds another one: `basePath` below stands in for that future key.
  const hostile = {
    filter: { signupType: 'rsvp' },
    sort: 'name',
    include: ['categories'],
    page: { size: 5 },
    basePath: '/evil',
    apiVersion: 'v2',
    apiHost: 'evil.example.com',
    raw: false,
  }

  assert.deepEqual(Object.keys(callerOptions('findAll', hostile)).sort(), [
    'filter',
    'include',
    'page',
    'sort',
  ])
  assert.deepEqual(Object.keys(callerOptions('find', hostile)), ['include'])
  for (const operation of ['create', 'update', 'delete'] as const) {
    assert.deepEqual(callerOptions(operation, hostile), {}, `${operation} takes no caller options`)
  }
})

for (const scenario of [
  {
    operation: 'create',
    tool: 'confetti_events_create',
    args: { name: 'Launch', startDate: '2026-09-01T10:00:00.000Z' },
    legit: (s: nock.Scope) => s.post('/events'),
    evil: (s: nock.Scope) => s.post('/events'),
  },
  {
    operation: 'update',
    tool: 'confetti_events_update',
    args: { id: 7, name: 'Renamed' },
    legit: (s: nock.Scope) => s.put('/events/7'),
    evil: (s: nock.Scope) => s.put('/events/7'),
  },
  {
    operation: 'delete',
    tool: 'confetti_pages_delete',
    args: { id: 3 },
    legit: (s: nock.Scope) => s.delete('/pages/3'),
    evil: (s: nock.Scope) => s.delete('/pages/3'),
  },
]) {
  test(`${scenario.operation} arguments cannot redirect the request to another host`, async () => {
    const legit = scenario
      .legit(nock(API, { reqheaders: { authorization: 'apikey sk_test_key' } }))
      .query(true)
      .reply(200, { data: { id: '1', type: 'events', attributes: {} } }, {
        'content-type': 'application/json',
      })
    const evil = scenario
      .evil(nock('http://evil.example.com'))
      .query(true)
      .reply(200, { data: { id: '1', type: 'events', attributes: {} } })

    await callTool(
      tool(scenario.tool),
      { ...scenario.args, apiKey: 'ATTACKER_KEY', apiHost: 'evil.example.com', apiProtocol: 'http' },
      { apiKey: 'sk_test_key' },
    )

    assert.ok(legit.isDone(), 'must reach the real host with the trusted key')
    assert.equal(evil.isDone(), false, 'tool arguments must not redirect the upstream request')
  })
}

test('one tenant never receives another tenant relationship record', async () => {
  // Verified bleed: confetti's adapter syncs every response into ONE
  // module-level yayson Store, and relationship references are resolved by
  // scanning every record ever synced in the process. Tenant B's linkage-only
  // reference to workspace 5 therefore resolved to tenant A's workspace.
  nock(API, { reqheaders: { authorization: 'apikey sk_tenant_a' } })
    .get('/events/1')
    .query(true)
    .reply(
      200,
      {
        data: {
          id: '1',
          type: 'events',
          attributes: { name: 'A event' },
          relationships: { workspace: { data: { id: '5', type: 'workspaces' } } },
        },
        included: [
          { id: '5', type: 'workspaces', attributes: { name: 'Tenant A', secret: 'A-only-data' } },
        ],
      },
      { 'content-type': 'application/json' },
    )

  nock(API, { reqheaders: { authorization: 'apikey sk_tenant_b' } })
    .get('/events/2')
    .query(true)
    .reply(
      200,
      {
        data: {
          id: '2',
          type: 'events',
          attributes: { name: 'B event' },
          relationships: { workspace: { data: { id: '5', type: 'workspaces' } } },
        },
      },
      { 'content-type': 'application/json' },
    )

  await callTool(tool('confetti_events_find'), { id: 1 }, { apiKey: 'sk_tenant_a' })
  const forB = await callTool(tool('confetti_events_find'), { id: 2 }, { apiKey: 'sk_tenant_b' })

  const serialised = JSON.stringify(forB)
  assert.doesNotMatch(serialised, /Tenant A/, "tenant A's workspace must not appear")
  assert.doesNotMatch(serialised, /A-only-data/)
})

test('find_all returns an envelope that reports pagination', async () => {
  nock(API)
    .get('/events')
    .query(true)
    .reply(
      200,
      {
        data: [{ id: '1', type: 'events', attributes: { name: 'Kickoff' } }],
        meta: { total: 137 },
        links: { next: '/events?page[number]=2' },
      },
      { 'content-type': 'application/json' },
    )

  const result = (await callTool(
    tool('confetti_events_find_all'),
    { page: { number: 1, size: 1 } },
    context,
  )) as { returned: number; page: { number: number; size: number }; more: string; records: unknown[] }

  assert.equal(result.returned, 1)
  assert.deepEqual(result.page, { number: 1, size: 1 })
  assert.equal(result.more, 'yes')
  assert.equal((result.records[0] as { name: string }).name, 'Kickoff')
})

test('an empty find_all page is distinguishable from a full one', async () => {
  nock(API).get('/events').query(true).reply(200, { data: [] }, {
    'content-type': 'application/json',
  })

  const result = (await callTool(tool('confetti_events_find_all'), {}, context)) as {
    returned: number
    more: string
    records: unknown[]
  }

  assert.equal(result.returned, 0)
  assert.equal(result.more, 'no')
  assert.deepEqual(result.records, [])
})

test('a delete is confirmed rather than returning an empty string', async () => {
  nock(API).delete('/pages/3').query(true).reply(204, '')

  const result = await callTool(tool('confetti_pages_delete'), { id: 3 }, context)

  assert.deepEqual(result, { deleted: true, resource: 'page', id: '3' })
})

test('the raw response flag cannot be set from tool arguments', async () => {
  const scope = nock(API)
    .get('/events')
    .query(true)
    .reply(200, { data: [{ id: '1', type: 'events', attributes: { name: 'Kickoff' } }] }, {
      'content-type': 'application/json',
    })

  const result = (await callTool(
    tool('confetti_events_find_all'),
    { raw: true },
    { apiKey: 'sk_test_key' },
  )) as Record<string, unknown>

  // The unparsed JSON:API body must never reach the caller: dispatch decides
  // that the upstream call is raw, and shaping is not caller-controlled.
  assert.equal(result['data'], undefined, 'the JSON:API envelope must not be returned')
  const records = result['records'] as Array<{ name: string }>
  assert.ok(Array.isArray(records), 'records must stay deserialised')
  assert.equal(records[0]!.name, 'Kickoff')
  scope.done()
})
