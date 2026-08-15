import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTools } from '../../src/tools/definitions.js'
import { parseToolFilter, selectTools, ToolFilterError, toolSetCacheKey } from '../../src/tools/filter.js'

const all = buildTools()
const select = (query: Record<string, unknown>) => selectTools(all, parseToolFilter(query))

test('no query returns all 63 tools', () => {
  assert.equal(select({}).length, 63)
})

test('ops=read returns the 29 read tools', () => {
  const tools = select({ ops: 'read' })
  assert.equal(tools.length, 29)
  assert.ok(tools.every((t) => t.operation === 'find' || t.operation === 'findAll'))
})

test('ops=get is an alias for read', () => {
  assert.equal(select({ ops: 'get' }).length, 29)
})

test('ops=get,post,put returns 53 tools and excludes deletes', () => {
  const tools = select({ ops: 'get,post,put' })
  assert.equal(tools.length, 53)
  assert.ok(tools.every((t) => t.operation !== 'delete'))
})

test('ops=read,create,update matches the HTTP verb spelling', () => {
  assert.equal(select({ ops: 'read,create,update' }).length, 53)
})

test('ops=delete returns the 10 delete tools', () => {
  assert.equal(select({ ops: 'delete' }).length, 10)
})

test('resources filter narrows to the named resources', () => {
  const tools = select({ resources: 'events,tickets' })
  assert.equal(tools.length, 8)
  assert.ok(tools.every((t) => t.modelKey === 'event' || t.modelKey === 'ticket'))
})

test('resources accepts snake_case as well as camelCase', () => {
  assert.equal(select({ resources: 'sponsor_levels' }).length, select({ resources: 'sponsorLevels' }).length)
  assert.equal(select({ resources: 'sponsor_levels' }).length, 4)
})

test('resources and ops compose', () => {
  const tools = select({ resources: 'events', ops: 'read' })
  assert.equal(tools.length, 2)
})

test('whitespace and empty segments are tolerated', () => {
  assert.equal(select({ ops: ' read , , create ' }).length, 29 + 13)
})

test('an unknown op is rejected with the valid values listed', () => {
  assert.throws(
    () => parseToolFilter({ ops: 'frobnicate' }),
    (error: unknown) => {
      assert.ok(error instanceof ToolFilterError)
      assert.match(error.message, /frobnicate/)
      assert.match(error.message, /read/)
      return true
    },
  )
})

test('an unknown resource is rejected with the valid values listed', () => {
  assert.throws(
    () => parseToolFilter({ resources: 'unicorns' }),
    (error: unknown) => {
      assert.ok(error instanceof ToolFilterError)
      assert.match(error.message, /unicorns/)
      assert.match(error.message, /events/)
      return true
    },
  )
})

test('cache key is stable regardless of ordering or spacing', () => {
  assert.equal(toolSetCacheKey({ ops: 'create,read' }), toolSetCacheKey({ ops: ' read , create ' }))
  assert.notEqual(toolSetCacheKey({ ops: 'read' }), toolSetCacheKey({ ops: 'create' }))
})
