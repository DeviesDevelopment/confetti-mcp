import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import nock from 'nock'
import Confetti from 'confetti'
import { buildTools, type GeneratedTool } from '../../src/tools/definitions.js'
import { callTool } from '../../src/tools/dispatch.js'

/**
 * One real, nock-pinned call per generated tool — all 63.
 *
 * Dispatch calls `confetti`'s static methods positionally through an
 * `unknown[]` cast (`resource.update(id, body, options)`), because the package
 * exports no per-resource types. That cast means `tsc` sees nothing if an
 * upstream bump reorders a signature, and the count-based drift guards only ask
 * whether a method exists. Before this file, exactly six of the 63 methods were
 * ever really called under nock (events findAll/find/create/update, pages
 * delete, contacts findAll), so `confetti_form_fields_update` sending its body
 * where the options belong would have shipped with a green suite and failed
 * only at runtime, for that one tool.
 *
 * Each case pins the four things a signature change moves: the HTTP method, the
 * URL path (so the id is argument one), the connection options reaching the
 * adapter (the Authorization header, and page[size] on a list), and — for
 * create/update — a request body that actually carries the caller's field. The
 * adapter only sends a body when `json` is truthy, so a swapped argument order
 * produces an empty PUT/POST, which is precisely what this catches.
 */

const API = 'https://api.confetti.events'
const CONTEXT = { apiKey: 'sk_signature_probe' }

/** A value distinctive enough to find in a rendered JSON:API body. */
const MARKER = 'signature-probe'

type Node = Record<string, unknown>

function isRecord(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The smallest value the advertised schema accepts for a node. Driven by the
 * schema rather than a hand-written fixture per model, so a new upstream
 * resource is covered the day it appears.
 */
function sampleFor(node: Node): unknown {
  const values = node['enum']
  if (Array.isArray(values) && values.length > 0) return values[0]

  const anyOf = node['anyOf']
  if (Array.isArray(anyOf)) {
    for (const branch of anyOf) if (isRecord(branch)) return sampleFor(branch)
  }

  switch (node['format']) {
    case 'date-time':
      return '2026-09-01T10:00:00.000Z'
    case 'email':
      return 'signature-probe@example.com'
    case 'uri':
      return 'https://example.com/signature-probe'
    case 'uuid':
      return '00000000-0000-4000-8000-000000000000'
  }

  switch (node['type']) {
    case 'string':
      return MARKER
    case 'number':
    case 'integer':
      return 1
    case 'boolean':
      return true
    case 'array': {
      const items = node['items']
      return isRecord(items) ? [sampleFor(items)] : []
    }
    case 'object': {
      const properties = isRecord(node['properties']) ? node['properties'] : {}
      const required = Array.isArray(node['required']) ? node['required'] : []
      const built: Node = {}
      for (const key of required) {
        const child = typeof key === 'string' ? properties[key] : undefined
        if (isRecord(child)) built[key as string] = sampleFor(child)
      }
      return built
    }
    default:
      return MARKER
  }
}

/** Every argument the advertised schema demands, plus one field to write. */
function argumentsFor(tool: GeneratedTool): Node {
  const schema = tool.definition.inputSchema
  const properties = schema.properties as Record<string, Node>
  const args: Node = {}

  for (const key of schema.required ?? []) {
    if (key === 'id') continue
    const node = properties[key]
    if (node) args[key] = sampleFor(node)
  }

  const writes = tool.operation === 'create' || tool.operation === 'update'
  if (writes && Object.keys(args).length === 0) {
    const first = Object.keys(properties).find((key) => key !== 'id')
    const node = first === undefined ? undefined : properties[first]
    if (first !== undefined && node) args[first] = sampleFor(node)
  }

  if (tool.operation !== 'findAll' && tool.operation !== 'create') args['id'] = '1'
  return args
}

const METHODS = {
  findAll: 'GET',
  find: 'GET',
  create: 'POST',
  update: 'PUT',
  delete: 'DELETE',
} as const

function pathOf(modelKey: string): string {
  const models = Confetti.models as unknown as Record<string, { path: string } | undefined>
  const model = models[modelKey]
  assert.ok(model, `Confetti.models.${modelKey} is missing`)
  return model.path
}

/** A string the request body must contain if the caller's fields reached it. */
function markerIn(args: Node): string | undefined {
  for (const [key, value] of Object.entries(args)) {
    if (key !== 'id' && typeof value === 'string') return value
  }
  return undefined
}

afterEach(() => {
  nock.cleanAll()
})

for (const tool of buildTools()) {
  const { name } = tool.definition
  const operation = tool.operation
  const method = METHODS[operation]
  const collection = operation === 'findAll' || operation === 'create'

  test(`${name} issues ${method} on the path its arguments name`, async () => {
    const path = collection ? `/${pathOf(tool.modelKey)}` : `/${pathOf(tool.modelKey)}/1`
    const args = argumentsFor(tool)
    let sentBody: unknown

    const scope = nock(API, { reqheaders: { authorization: `apikey ${CONTEXT.apiKey}` } })
      .intercept(path, method, (body: unknown) => {
        sentBody = body
        return true
      })
      .query((query: Record<string, unknown>) => {
        // A list call proves the options object reached the adapter: it is the
        // only place page can come from.
        if (operation !== 'findAll') return true
        return query['page[size]'] === '25'
      })
      .reply(
        200,
        { data: { id: '1', type: pathOf(tool.modelKey), attributes: {} } },
        { 'content-type': 'application/json' },
      )

    await callTool(tool, args, CONTEXT)

    assert.ok(scope.isDone(), `${name} did not issue ${method} ${path} with the connection's key`)

    if (operation !== 'create' && operation !== 'update') return

    assert.ok(isRecord(sentBody), `${name} sent no request body — its json argument was dropped`)
    const document = sentBody['data']
    assert.ok(isRecord(document), `${name} sent a body that is not a JSON:API document`)

    const marker = markerIn(args)
    if (marker !== undefined) {
      assert.ok(
        JSON.stringify(sentBody).includes(marker),
        `${name} sent a body without the caller's own field: ${JSON.stringify(sentBody)}`,
      )
    }
  })
}
