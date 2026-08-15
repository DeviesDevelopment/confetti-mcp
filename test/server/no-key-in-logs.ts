import { test } from 'node:test'
import assert from 'node:assert/strict'
import nock from 'nock'
import { createApp } from '../../src/server/app.js'
import { loadConfig } from '../../src/config.js'

const API = 'https://api.confetti.events'
const KEY = 'sk_live_canary_do_not_log_me'

/**
 * The server logs deliberately (tool-call failures, startup, unhandled errors). Every
 * one of those paths is a chance to leak the caller's API key, which arrives in four
 * different carriers and is attached to every upstream request.
 *
 * This captures EVERY output channel — console.* and direct stdout/stderr writes, which
 * a logger may use instead of console — across every carrier and every error class, and
 * asserts the key never appears. It is the regression guard for "logs must never include
 * the access token".
 */

interface Captured {
  output: string
  restore: () => void
}

function captureAllOutput(): Captured {
  const chunks: string[] = []
  const origConsole = { ...console }
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)

  for (const level of ['log', 'error', 'warn', 'info', 'debug', 'trace'] as const) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(console as any)[level] = (...args: unknown[]) => chunks.push(args.map(String).join(' '))
  }
  // A logger writing straight to the fd bypasses console entirely — capture that too.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process.stdout as any).write = (c: unknown) => { chunks.push(String(c)); return true }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process.stderr as any).write = (c: unknown) => { chunks.push(String(c)); return true }

  return {
    get output() { return chunks.join('\n') },
    restore() {
      Object.assign(console, origConsole)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(process.stdout as any).write = origOut
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(process.stderr as any).write = origErr
    },
  } as Captured
}

async function startServer() {
  const app = createApp(loadConfig({}))
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address() as { port: number }
  return { server, port }
}

const rpc = (port: number, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

test('the api key never reaches any log channel, via any carrier, on any path', async (t) => {
  const { server, port } = await startServer()
  t.after(() => { server.close(); nock.cleanAll() })

  const cap = captureAllOutput()
  try {
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' }

    // Every carrier, on a success path.
    await rpc(port, '/mcp', list, { authorization: `Bearer ${KEY}` })
    await rpc(port, '/mcp', list, { 'x-api-key': KEY })
    await rpc(port, `/mcp?apiKey=${KEY}`, list)
    await rpc(port, `/mcp/k/${KEY}`, list)

    // Filter rejection (400).
    await rpc(port, `/mcp/k/${KEY}?ops=frobnicate`, list)

    // Unmatched route (404) — the path carrier puts the key in the URL.
    await fetch(`http://127.0.0.1:${port}/mcp/k/${KEY}/nope`, { method: 'PATCH' })

    // Malformed body.
    await rpc(port, `/mcp?apiKey=${KEY}`, '{not json', {})

    // A failing tool call: upstream 500, which is the path that logs.
    nock(API).get('/events').query(true).reply(500, 'upstream exploded')
    await rpc(port, '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'confetti_events_find_all', arguments: {} },
    }, { authorization: `Bearer ${KEY}` })

    // A tool call whose arguments are rejected before dispatch.
    await rpc(port, `/mcp?apiKey=${KEY}`, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'confetti_events_update', arguments: { id: 'bogus/../x', titel: 'typo' } },
    })
  } finally {
    cap.restore()
  }

  assert.ok(
    !cap.output.includes(KEY),
    `api key leaked into logs. Captured output:\n${cap.output.slice(0, 2000)}`,
  )
})

test('the capture harness itself can detect a leak', () => {
  // Guards against the assertion above passing because nothing was captured at all.
  const cap = captureAllOutput()
  try {
    console.log(`pretend a logger printed ${KEY}`)
    process.stderr.write(`and a raw write of ${KEY}\n`)
  } finally {
    cap.restore()
  }
  assert.ok(cap.output.includes(KEY), 'harness failed to capture output — the leak test would be vacuous')
})
