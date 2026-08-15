import { test } from 'node:test'
import assert from 'node:assert/strict'
import { camelToSnake, toolName } from '../../src/tools/names.js'

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

test('every generated name is a legal MCP tool name', () => {
  const name = toolName('scheduleItems', 'update')
  assert.match(name, /^[a-zA-Z0-9_-]{1,128}$/)
})
