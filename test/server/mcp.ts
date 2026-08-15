import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import nock from 'nock'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
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

test('an unknown tool name returns an isError result', async () => {
  const { server, port } = await startServer()
  const { client, transport } = await connect(port)

  const result = await client.callTool({ name: 'confetti_nope_find', arguments: {} })
  assert.equal(result.isError, true)

  await transport.close()
  server.close()
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

test('GET /mcp is rejected because the server is stateless', async () => {
  const { server, port } = await startServer()
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    headers: { authorization: 'Bearer sk_test_key' },
  })
  assert.equal(res.status, 405)
  server.close()
})
