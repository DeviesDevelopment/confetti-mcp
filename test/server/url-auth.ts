import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import nock from 'nock'
import { createApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/config.js'

async function startServer() {
  const app = createApp(loadConfig({}))
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
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

afterEach(() => {
  nock.cleanAll()
})

test('the path route authenticates without a header', async () => {
  const { server, port } = await startServer()
  const res = await rpc(port, '/mcp/k/sk_path_key')
  assert.equal(res.status, 200)
  server.close()
})

test('the path route honours the ops filter', async () => {
  const { server, port } = await startServer()
  const res = await rpc(port, '/mcp/k/sk_path_key?ops=read')
  assert.equal(res.status, 200)
  const text = await res.text()
  const listed = (text.match(/"name":"confetti_/g) ?? []).length
  assert.equal(listed, 29)
  server.close()
})

test('the query carrier authenticates without a header', async () => {
  const { server, port } = await startServer()
  const res = await rpc(port, '/mcp?apiKey=sk_query_key')
  assert.equal(res.status, 200)
  server.close()
})

test('an apiKey in the query does not disturb tool filtering', async () => {
  const { server, port } = await startServer()
  const res = await rpc(port, '/mcp?apiKey=sk_query_key&ops=read')
  assert.equal(res.status, 200)
  const text = await res.text()
  const listed = (text.match(/"name":"confetti_/g) ?? []).length
  assert.equal(listed, 29, 'apiKey must be ignored by parseToolFilter, not rejected as an unknown key')
  server.close()
})

test('an unknown query parameter is still ignored rather than rejected', async () => {
  const { server, port } = await startServer()
  const res = await rpc(port, '/mcp?apiKey=sk_query_key&utm_source=docs')
  assert.equal(res.status, 200)
  server.close()
})

test('the api key never appears in stdout or stderr', async () => {
  const { server, port } = await startServer()
  const captured: string[] = []
  const originalLog = console.log
  const originalError = console.error
  console.log = (...args: unknown[]) => captured.push(args.join(' '))
  console.error = (...args: unknown[]) => captured.push(args.join(' '))

  try {
    await rpc(port, '/mcp/k/sk_super_secret_value')
  } finally {
    console.log = originalLog
    console.error = originalError
    server.close()
  }

  assert.ok(
    !captured.join('\n').includes('sk_super_secret_value'),
    `api key leaked into logs: ${captured.join('\n')}`,
  )
})
