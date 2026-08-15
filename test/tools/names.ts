import { test } from 'node:test'
import assert from 'node:assert/strict'
import { camelToSnake, toolName } from '../../src/tools/names.js'
import { buildTools } from '../../src/tools/definitions.js'

test('camelToSnake converts camelCase', () => {
  assert.equal(camelToSnake('sponsorLevels'), 'sponsor_levels')
  assert.equal(camelToSnake('formFields'), 'form_fields')
  assert.equal(camelToSnake('ticketBatches'), 'ticket_batches')
  assert.equal(camelToSnake('scheduleItems'), 'schedule_items')
  assert.equal(camelToSnake('findAll'), 'find_all')
})

test('camelToSnake leaves single words alone', () => {
  assert.equal(camelToSnake('events'), 'events')
  assert.equal(camelToSnake('find'), 'find')
})

test('toolName composes the prefixed name', () => {
  assert.equal(toolName('events', 'findAll'), 'confetti_events_find_all')
  assert.equal(toolName('sponsorLevels', 'delete'), 'confetti_sponsor_levels_delete')
  assert.equal(toolName('forms', 'find'), 'confetti_forms_find')
})

/**
 * Every name, not one sample. The names are derived from upstream resource and
 * operation keys, so the only thing standing between an upstream rename and a
 * tool a client refuses to register is this grammar — and checking a single
 * hardcoded name checked the one name least likely to break.
 */
const LEGAL_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/

test('every generated name is a legal MCP tool name', () => {
  const tools = buildTools()
  assert.equal(tools.length, 63, 'the surface must be the whole surface')
  for (const tool of tools) {
    assert.match(
      tool.definition.name,
      LEGAL_TOOL_NAME,
      `${tool.definition.name} (${tool.modelKey}.${tool.operation}) is not a legal MCP tool name`,
    )
  }
})

test('every generated name is unique and prefixed', () => {
  const names = buildTools().map((tool) => tool.definition.name)
  assert.equal(new Set(names).size, names.length, 'two tools would answer to the same name')
  for (const name of names) assert.match(name, /^confetti_/)
})
