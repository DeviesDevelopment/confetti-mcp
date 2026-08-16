import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/config.js'

async function startServer(t: TestContext) {
  const app = createApp(loadConfig({}))
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => { server.close() })
  const { port } = server.address() as { port: number }
  return { server, port }
}

const HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  authorization: 'Bearer sk_test_key',
}

async function post(port: number, body: string, path = '/mcp') {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: HEADERS, body })
  return { status: res.status, body: (await res.json()) as { error?: { code?: number; message?: string } } }
}

test('an unparseable body is the client\'s fault: 400 / -32700', async (t) => {
  // Reported as 500/-32603 it looks like a server fault, so retry-on-5xx logic
  // retries a permanently-bad request forever.
  const { port } = await startServer(t)
  const res = await post(port, '{invalid json')

  assert.equal(res.status, 400)
  assert.equal(res.body.error?.code, -32700)
})

test('an oversized body is rejected with 413, not 500', async (t) => {
  const { port } = await startServer(t)
  const huge = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(5 * 1024 * 1024) } })
  const res = await post(port, huge)

  assert.equal(res.status, 413)
  assert.ok(res.body.error?.code === -32600 || res.body.error?.code === -32700, `unexpected code ${res.body.error?.code}`)
})

test('a malformed body never echoes the url that carried the key', async (t) => {
  const { port } = await startServer(t)
  const res = await post(port, '{invalid json', '/mcp/k/sk_path_key')

  assert.equal(res.status, 400)
  assert.ok(!JSON.stringify(res.body).includes('sk_path_key'), 'the /mcp/k/<key> path must never be echoed')
})

test('a client-caused parse failure is not logged as an unhandled server error', async (t) => {
  const { port } = await startServer(t)

  const lines: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return original(chunk as string, ...(rest as []))
  }) as typeof process.stderr.write

  try {
    await post(port, '{invalid json', '/mcp/k/sk_path_key')
  } finally {
    process.stderr.write = original
  }

  const logged = lines.join('')
  assert.ok(!/"level":"error"/.test(logged), 'an attacker- or typo-triggerable parse failure must not fill the error log')
  assert.ok(!logged.includes('sk_path_key'), 'no log line may carry the url key')
  for (const line of logged.split('\n').filter(Boolean)) {
    const entry = JSON.parse(line) as { level?: string; msg?: string; requestId?: string }
    assert.equal(entry.level, 'warn')
    assert.equal(typeof entry.requestId, 'string')
  }
})

test('the discovery response advertises the filters that shrink the tool surface', async (t) => {
  // ?ops= / ?resources= is the one feature that cuts the ~19k-token tool
  // surface, and it was invisible at the moment someone configures a connection.
  const { port } = await startServer(t)
  const res = await fetch(`http://127.0.0.1:${port}/`)
  const body = (await res.json()) as { usage?: string }

  assert.equal(res.status, 200)
  const usage = JSON.stringify(body)
  assert.match(usage, /\?ops=/)
  assert.match(usage, /\?resources=/)
})

test('a non-ToolFilterError thrown while handling a request is answered generically, without the url or a key', async (t) => {
  // The 500 branch of the error middleware is distinct from the ToolFilterError
  // 400 branch and from every 4xx `clientFault` branch: it is reached only when
  // something inside `handleMcp` throws unexpectedly after the tool-filter
  // check has already passed. Nothing reachable purely through crafted HTTP
  // input takes that path — `extractApiKey` and `getToolSet` are total
  // functions over their inputs — so the only way to exercise it without
  // editing src/ is to mock `createMcpServer` for the duration of this test via
  // node's built-in module mocking, forcing exactly the kind of error class
  // (TypeError, not ToolFilterError) this branch exists to handle safely.
  const KEY = 'sk_secret_500_path_test_key'
  const mcpReal = await import('../../src/server/mcp.js')
  const mock = t.mock.module('../../src/server/mcp.js', {
    namedExports: {
      ...mcpReal,
      createMcpServer: () => {
        throw new TypeError('forced failure to reach the 500 path')
      },
    },
  })
  t.after(() => mock.restore())

  // A fresh, cache-busted import: the module already loaded at the top of this
  // file resolved its `createMcpServer` binding against the real mcp.js before
  // the mock above existed, so it would still call the real implementation.
  const { createApp: createMockedApp } = (await import(
    `../../src/server/app.js?bust=${Date.now()}`
  )) as typeof import('../../src/server/app.js')
  const app = createMockedApp(loadConfig({}))
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => { server.close() })
  const { port } = server.address() as { port: number }

  const res = await post(port, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), `/mcp/k/${KEY}`)

  assert.equal(res.status, 500)
  assert.equal(res.body.error?.code, -32603)
  assert.equal(res.body.error?.message, 'Internal server error.')

  const raw = JSON.stringify(res.body)
  assert.ok(!raw.includes(KEY), 'the 500 body must never include the caller key')
  assert.ok(!raw.includes('/mcp/k/'), 'the 500 body must never echo the request url')
})
