import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import nock from 'nock'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/config.js'

const API = 'https://api.confetti.events'

async function startServer() {
  const app = createApp(loadConfig({}))
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address() as { port: number }
  return { server, port }
}

async function connect(port: number, path = '/mcp', headers: Record<string, string> = {}) {
  const client = new Client({ name: 'test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${path}`), {
    requestInit: { headers: { authorization: 'Bearer sk_test_key', ...headers } },
  })
  await client.connect(transport)
  return { client, transport }
}

afterEach(() => {
  nock.cleanAll()
})

test('lists all 63 tools', async () => {
  const { server, port } = await startServer()
  const { client, transport } = await connect(port)

  const { tools } = await client.listTools()
  assert.equal(tools.length, 63)
  assert.ok(tools.some((t) => t.name === 'confetti_events_find_all'))

  await transport.close()
  server.close()
})

test('ops=read narrows the listed tools to 29', async () => {
  const { server, port } = await startServer()
  const { client, transport } = await connect(port, '/mcp?ops=read')

  const { tools } = await client.listTools()
  assert.equal(tools.length, 29)

  await transport.close()
  server.close()
})

test('calling a tool reaches Confetti with the caller api key', async () => {
  const { server, port } = await startServer()
  const scope = nock(API, { reqheaders: { authorization: 'apikey sk_test_key' } })
    .get('/events')
    .query(true)
    .reply(200, { data: [] }, { 'content-type': 'application/json' })

  const { client, transport } = await connect(port)
  const result = await client.callTool({ name: 'confetti_events_find_all', arguments: {} })

  assert.notEqual(result.isError, true)
  scope.done()

  await transport.close()
  server.close()
})

test('an upstream failure comes back as an isError result, not a protocol error', async () => {
  const { server, port } = await startServer()
  nock(API)
    .get('/events/999')
    .query(true)
    .reply(404, { message: 'Event not found' }, { 'content-type': 'application/json' })

  const { client, transport } = await connect(port)
  const result = await client.callTool({ name: 'confetti_events_find', arguments: { id: 999 } })

  assert.equal(result.isError, true)
  const content = result.content as Array<{ type: string; text: string }>
  assert.match(content[0]!.text, /Not found in 'confetti_events_find'/)

  await transport.close()
  server.close()
})

test('an unknown tool name is a protocol error, not a tool result', async () => {
  // The spec names "Unknown tools" as its canonical -32602, and clients key on
  // it to refresh a stale tool list or drop a hallucinated name. An isError
  // result instead feeds "Unknown tool" back to the model, which retries
  // variations of it.
  const { server, port } = await startServer()
  const { client, transport } = await connect(port)

  await assert.rejects(
    () => client.callTool({ name: 'confetti_nope_find', arguments: {} }),
    (error: unknown) => {
      assert.equal((error as { code?: number }).code, ErrorCode.InvalidParams)
      assert.match((error as Error).message, /confetti_nope_find/)
      return true
    },
  )

  await transport.close()
  server.close()
})

test('the connection ships instructions, scoped to the tools it actually has', async () => {
  const { server, port } = await startServer()
  const { client, transport } = await connect(port, '/mcp?resources=events')

  const instructions = client.getInstructions()
  assert.ok(instructions && instructions.length > 0, 'ServerOptions.instructions went unused')
  assert.match(instructions, /Confetti/)
  assert.ok(!/tickets/i.test(instructions), 'a scoped connection must not be oriented around tools it lacks')

  await transport.close()
  server.close()
})

test('tool results are compact JSON, not pretty-printed', async () => {
  // Indentation was ~19% of every read response, paid on every call.
  const { server, port } = await startServer()
  nock(API)
    .get('/events')
    .query(true)
    .reply(200, { data: [{ id: '1', type: 'events', attributes: { name: 'DevSummit' } }] }, { 'content-type': 'application/json' })

  const { client, transport } = await connect(port)
  const result = await client.callTool({ name: 'confetti_events_find_all', arguments: {} })
  const content = result.content as Array<{ type: string; text: string }>

  assert.match(content[0]!.text, /DevSummit/)
  assert.ok(!content[0]!.text.includes('\n'), 'a tool result must not carry indentation')

  await transport.close()
  server.close()
})

test('a failed tool call is logged as one structured line, without key, args or message', async () => {
  const { server, port } = await startServer()
  nock(API)
    .get('/events/999')
    .query(true)
    .reply(404, { message: 'Event not found for key sk_test_key' }, { 'content-type': 'application/json' })

  const lines: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  // Intercept the stream, not console.*: a logger added later writes here.
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return original(chunk as string, ...(rest as []))
  }) as typeof process.stderr.write

  try {
    const { client, transport } = await connect(port)
    await client.callTool({ name: 'confetti_events_find', arguments: { id: '999' } })
    await transport.close()
  } finally {
    process.stderr.write = original
  }
  server.close()

  const logged = lines.join('').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const failure = logged.find((entry) => entry.msg === 'tool_call_failed')
  assert.ok(failure, `expected a tool_call_failed line, got ${JSON.stringify(logged)}`)
  assert.equal(failure.tool, 'confetti_events_find')
  assert.equal(failure.error, 'NotFoundError')
  assert.equal(typeof failure.durationMs, 'number')
  assert.equal(typeof failure.requestId, 'string')

  const all = lines.join('')
  assert.ok(!all.includes('sk_test_key'), 'the api key must never reach a log')
  assert.ok(!all.includes('999'), 'tool arguments must never reach a log')
  assert.ok(!all.includes('Event not found'), 'an error message can carry caller data and must not be logged')
})

test('a successful tool call logs nothing', async () => {
  const { server, port } = await startServer()
  nock(API).get('/events').query(true).reply(200, { data: [] }, { 'content-type': 'application/json' })

  const lines: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return original(chunk as string, ...(rest as []))
  }) as typeof process.stderr.write

  try {
    const { client, transport } = await connect(port)
    await client.callTool({ name: 'confetti_events_find_all', arguments: {} })
    await transport.close()
  } finally {
    process.stderr.write = original
  }
  server.close()

  assert.equal(lines.join('').trim(), '', 'the success path stays silent — this is a per-request-key server')
})

test('a filtered-out tool is refused when called, not merely hidden from the list', async () => {
  const { server, port } = await startServer()
  const { client, transport } = await connect(port, '/mcp?ops=read')

  const { tools } = await client.listTools()
  assert.equal(
    tools.find((t) => t.name === 'confetti_pages_delete'),
    undefined,
    'a read-only connection must not list a delete tool',
  )

  // The filter must be enforced, not advisory: naming the tool directly must fail.
  const result = await client.callTool({ name: 'confetti_pages_delete', arguments: { id: 1 } })
  assert.equal(result.isError, true, 'a read-only connection must refuse a delete call')
  const content = result.content as Array<{ type: string; text: string }>
  assert.match(content[0]!.text, /not available on this connection/)

  await transport.close()
  server.close()
})

test('every listed tool on a filtered connection belongs to the requested ops', async () => {
  const { server, port } = await startServer()
  const { client, transport } = await connect(port, '/mcp?ops=read')

  const { tools } = await client.listTools()
  assert.equal(tools.length, 29)
  for (const tool of tools) {
    assert.match(
      tool.name,
      /_(find|find_all)$/,
      `${tool.name} is not a read operation but was listed on a ?ops=read connection`,
    )
  }

  await transport.close()
  server.close()
})

test('tool arguments cannot override the connection api key or host', async () => {
  const { server, port } = await startServer()
  const legit = nock(API, { reqheaders: { authorization: 'apikey sk_test_key' } })
    .get('/events')
    .query(true)
    .reply(200, { data: [] }, { 'content-type': 'application/json' })
  const evil = nock('http://evil.example.com').get('/events').query(true).reply(200, { data: [] })

  const { client, transport } = await connect(port)
  await client.callTool({
    name: 'confetti_events_find_all',
    arguments: { apiKey: 'ATTACKER_KEY', apiHost: 'evil.example.com', apiProtocol: 'http' },
  })

  assert.ok(legit.isDone(), 'the trusted connection context must win over tool arguments')
  assert.equal(evil.isDone(), false, 'tool arguments must not be able to redirect the upstream call')

  await transport.close()
  server.close()
})

test('a request with no api key is rejected with 401', async () => {
  const { server, port } = await startServer()
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })

  assert.equal(res.status, 401)
  assert.match(res.headers.get('www-authenticate') ?? '', /Bearer/)
  server.close()
})

test('an invalid ops value is rejected with 400 and lists valid values', async () => {
  const { server, port } = await startServer()
  const res = await fetch(`http://127.0.0.1:${port}/mcp?ops=frobnicate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer sk_test_key',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })

  assert.equal(res.status, 400)
  const body = await res.json()
  assert.match(JSON.stringify(body), /frobnicate/)
  server.close()
})

test('a repeated ops parameter cannot widen the tool set', async () => {
  const { server, port } = await startServer()
  const { client, transport } = await connect(port, '/mcp?ops=read&ops=read')
  const { tools } = await client.listTools()
  assert.equal(tools.length, 29, 'a repeated parameter must not disable the filter')
  assert.equal(tools.filter((t) => t.name.endsWith('_delete')).length, 0)
  await transport.close()
  server.close()
})

test('concurrent connections do not leak api keys across requests', async () => {
  const { server, port } = await startServer()

  const scopeA = nock(API, { reqheaders: { authorization: 'apikey sk_tenant_a' } })
    .get('/events').query(true).reply(200, { data: [] }, { 'content-type': 'application/json' })
  const scopeB = nock(API, { reqheaders: { authorization: 'apikey sk_tenant_b' } })
    .get('/contacts').query(true).reply(200, { data: [] }, { 'content-type': 'application/json' })

  const a = await connect(port, '/mcp', { authorization: 'Bearer sk_tenant_a' })
  const b = await connect(port, '/mcp', { authorization: 'Bearer sk_tenant_b' })

  await Promise.all([
    a.client.callTool({ name: 'confetti_events_find_all', arguments: {} }),
    b.client.callTool({ name: 'confetti_contacts_find_all', arguments: {} }),
  ])

  // Each nock scope only matches if that tenant's own key was sent.
  assert.ok(scopeA.isDone(), "tenant A's request did not carry tenant A's key")
  assert.ok(scopeB.isDone(), "tenant B's request did not carry tenant B's key")

  await a.transport.close()
  await b.transport.close()
  server.close()
})

test('GET /mcp is rejected because the server is stateless', async () => {
  const { server, port } = await startServer()
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    headers: { authorization: 'Bearer sk_test_key' },
  })
  assert.equal(res.status, 405)
  server.close()
})
