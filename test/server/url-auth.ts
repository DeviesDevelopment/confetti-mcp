import { test, afterEach, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import nock from 'nock'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/config.js'

const API = 'https://api.confetti.events'

async function startServer(t: TestContext) {
  const app = createApp(loadConfig({}))
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => { server.close() })
  const { port } = server.address() as { port: number }
  return { server, port }
}

function rpc(port: number, path: string) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
}

/**
 * A carrier connection with no Authorization header at all: the key can only
 * come from the URL, which is the whole point of these tests.
 */
async function connect(t: TestContext, port: number, path: string) {
  const client = new Client({ name: 'test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${path}`))
  await client.connect(transport)
  t.after(async () => { await transport.close() })
  return { client, transport }
}

/**
 * Captures everything written to stdout and stderr, not just `console.*`.
 * The likely way request logging arrives is `morgan`/`pino`, and both write to
 * `process.stdout` directly — a console-only canary stays green while the key
 * streams into the platform's log capture.
 */
async function captureOutput(work: () => Promise<void>): Promise<string> {
  const chunks: string[] = []
  const streams = [process.stdout, process.stderr] as const
  const originals = streams.map((stream) => stream.write.bind(stream))

  streams.forEach((stream, index) => {
    stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return originals[index]!(chunk as string, ...(rest as []))
    }) as typeof stream.write
  })

  try {
    await work()
  } finally {
    streams.forEach((stream, index) => {
      stream.write = originals[index]! as typeof stream.write
    })
  }

  return chunks.join('')
}

afterEach(() => {
  nock.cleanAll()
})

test('the path route authenticates without a header', async (t) => {
  const { port } = await startServer(t)
  const res = await rpc(port, '/mcp/k/sk_path_key')
  assert.equal(res.status, 200)
})

test('the path route honours the ops filter', async (t) => {
  const { port } = await startServer(t)
  const res = await rpc(port, '/mcp/k/sk_path_key?ops=read')
  assert.equal(res.status, 200)
  const text = await res.text()
  const listed = (text.match(/"name":"confetti_/g) ?? []).length
  assert.equal(listed, 29)
})

test('the query carrier authenticates without a header', async (t) => {
  const { port } = await startServer(t)
  const res = await rpc(port, '/mcp?apiKey=sk_query_key')
  assert.equal(res.status, 200)
})

test('an apiKey in the query does not disturb tool filtering', async (t) => {
  const { port } = await startServer(t)
  const res = await rpc(port, '/mcp?apiKey=sk_query_key&ops=read')
  assert.equal(res.status, 200)
  const text = await res.text()
  const listed = (text.match(/"name":"confetti_/g) ?? []).length
  assert.equal(listed, 29, 'apiKey must be ignored by parseToolFilter, not rejected as an unknown key')
})

test('an unknown query parameter is still ignored rather than rejected', async (t) => {
  const { port } = await startServer(t)
  const res = await rpc(port, '/mcp?apiKey=sk_query_key&utm_source=docs')
  assert.equal(res.status, 200)
})

test('nothing written to stdout or stderr can capture a url-carried api key', async (t) => {
  // The server does log now — one line per failed tool call — so the invariant
  // is no longer "nothing is logged" but "the key is never in what is logged".
  const { port } = await startServer(t)

  const output = await captureOutput(async () => {
    await rpc(port, '/mcp/k/sk_super_secret_value')
  })

  assert.ok(
    !output.includes('sk_super_secret_value'),
    `api key leaked into process output: ${output}`,
  )
})

test('the failure log line the server does emit still carries no url-carried key', async (t) => {
  const { port } = await startServer(t)
  nock(API)
    .get('/events/999')
    .query(true)
    .reply(404, { message: 'no such event' }, { 'content-type': 'application/json' })

  const output = await captureOutput(async () => {
    const { client } = await connect(t, port, '/mcp/k/sk_super_secret_value')
    await client.callTool({ name: 'confetti_events_find', arguments: { id: '999' } })
  })

  // The canary is only worth anything if it is watching a request that logs.
  assert.match(output, /tool_call_failed/, 'expected the server to have logged this failure')
  assert.ok(!output.includes('sk_super_secret_value'), `api key leaked into logs: ${output}`)
})

test('the path-carried key is the key sent upstream', async (t) => {
  // tools/list needs no upstream call, so every test above this one would still
  // pass if extractApiKey mangled the key — percent-decoding, the wrong params
  // object — and every real tool call failed to authenticate.
  const { port } = await startServer(t)
  const scope = nock(API, { reqheaders: { authorization: 'apikey sk_path_key' } })
    .get('/events')
    .query(true)
    .reply(200, { data: [] }, { 'content-type': 'application/json' })

  const { client } = await connect(t, port, '/mcp/k/sk_path_key')
  const result = await client.callTool({ name: 'confetti_events_find_all', arguments: {} })

  assert.notEqual(result.isError, true, JSON.stringify(result.content))
  scope.done()
})

test('the query-carried key is the key sent upstream', async (t) => {
  const { port } = await startServer(t)
  const scope = nock(API, { reqheaders: { authorization: 'apikey sk_query_key' } })
    .get('/contacts')
    .query(true)
    .reply(200, { data: [] }, { 'content-type': 'application/json' })

  const { client } = await connect(t, port, '/mcp?apiKey=sk_query_key')
  const result = await client.callTool({ name: 'confetti_contacts_find_all', arguments: {} })

  assert.notEqual(result.isError, true, JSON.stringify(result.content))
  scope.done()
})

test('a percent-encoded path key is decoded before it is forwarded', async (t) => {
  // The path segment is the one carrier that can arrive percent-encoded, and
  // decoding it in the wrong place is the exact wiring bug this pins.
  const { port } = await startServer(t)
  const scope = nock(API, { reqheaders: { authorization: 'apikey sk_path+key/with=chars' } })
    .get('/events')
    .query(true)
    .reply(200, { data: [] }, { 'content-type': 'application/json' })

  const { client } = await connect(
    t,
    port,
    `/mcp/k/${encodeURIComponent('sk_path+key/with=chars')}`,
  )
  const result = await client.callTool({ name: 'confetti_events_find_all', arguments: {} })

  assert.notEqual(result.isError, true, JSON.stringify(result.content))
  scope.done()
})

test('the api key never appears in an error response body', async (t) => {
  const { port } = await startServer(t)

  // ?ops=frobnicate makes ToolFilterError produce a 400 whose message quotes the
  // offending value. If an error message ever widened to include the URL or the
  // whole query, the path-carried key would ride along into the client's hands.
  const res = await fetch(`http://127.0.0.1:${port}/mcp/k/sk_super_secret_value?ops=frobnicate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })

  assert.equal(res.status, 400)
  const body = await res.text()
  assert.ok(!body.includes('sk_super_secret_value'), `api key leaked into the error body: ${body}`)
})

test('the api key never appears in a successful response body', async (t) => {
  const { port } = await startServer(t)

  const res = await rpc(port, '/mcp/k/sk_super_secret_value?ops=read')
  assert.equal(res.status, 200)
  const body = await res.text()
  assert.ok(!body.includes('sk_super_secret_value'), 'api key leaked into a successful response')
})

test('the api key never appears in a 404 response body', async (t) => {
  const { port } = await startServer(t)
  for (const [method, path] of [
    ['PATCH', '/mcp/k/sk_super_secret_value'],
    ['POST', '/mcp/k/sk_super_secret_value/extra'],
    ['GET', '/nonexistent/sk_super_secret_value'],
  ] as const) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method })
    assert.equal(res.status, 404)
    const body = await res.text()
    assert.ok(!body.includes('sk_super_secret_value'), `${method} ${path} leaked the key: ${body}`)
  }
})
