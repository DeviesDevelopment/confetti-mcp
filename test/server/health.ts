import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/config.js'

test('GET / reports server identity', async () => {
  const app = createApp(loadConfig({}))
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address() as { port: number }

  const res = await fetch(`http://127.0.0.1:${port}/`)
  const body = await res.json()

  assert.equal(res.status, 200)
  assert.equal(body.status, 'ok')
  assert.equal(body.server, 'confetti-mcp')
  assert.equal(typeof body.version, 'string')
  assert.match(body.usage, /Authorization: Bearer/)

  server.close()
})

test('loadConfig applies defaults', () => {
  const config = loadConfig({})
  assert.equal(config.port, 8080)
  assert.equal(config.apiHost, 'api.confetti.events')
  assert.equal(config.apiProtocol, 'https')
})

test('loadConfig reads overrides from env', () => {
  const config = loadConfig({ PORT: '3000', CONFETTI_API_HOST: 'staging.confetti.events' })
  assert.equal(config.port, 3000)
  assert.equal(config.apiHost, 'staging.confetti.events')
})

test('an empty PORT falls back to the default rather than binding a random port', () => {
  assert.equal(loadConfig({ PORT: '' }).port, 8080)
  assert.equal(loadConfig({ PORT: '   ' }).port, 8080)
})

test('an invalid PORT is rejected loudly', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), /Invalid PORT/)
  assert.throws(() => loadConfig({ PORT: '0' }), /Invalid PORT/)
  assert.throws(() => loadConfig({ PORT: '99999' }), /Invalid PORT/)
})
