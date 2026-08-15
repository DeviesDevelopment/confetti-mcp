import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toolErrorMessage } from '../../src/tools/errors.js'

function named(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

test('maps ParameterError', () => {
  const message = toolErrorMessage(named('ParameterError', 'startDate is required'), 'confetti_events_create')
  assert.match(message, /Invalid parameters for 'confetti_events_create'/)
  assert.match(message, /startDate is required/)
})

test('maps NotFoundError', () => {
  const message = toolErrorMessage(named('NotFoundError', 'Event 99 not found'), 'confetti_events_find')
  assert.match(message, /Not found in 'confetti_events_find'/)
  assert.match(message, /Event 99 not found/)
})

test('maps OperationNotFoundError', () => {
  const message = toolErrorMessage(named('OperationNotFoundError', 'nope'), 'confetti_events_update')
  assert.match(message, /Unsupported operation 'confetti_events_update'/)
})

test('maps ZodError to the parameter shape', () => {
  const message = toolErrorMessage(named('ZodError', 'Expected string, received number'), 'confetti_events_create')
  assert.match(message, /Invalid parameters for 'confetti_events_create'/)
})

test('falls back for unknown errors and names the type', () => {
  const message = toolErrorMessage(named('TypeError', 'x is not a function'), 'confetti_events_find')
  assert.match(message, /Error in 'confetti_events_find'/)
  assert.match(message, /\[TypeError\]/)
  assert.match(message, /x is not a function/)
})

test('handles non-Error throwables', () => {
  const message = toolErrorMessage('a bare string', 'confetti_events_find')
  assert.match(message, /Error in 'confetti_events_find'/)
  assert.match(message, /a bare string/)
})

test('never echoes an api key that appears in the message', () => {
  const message = toolErrorMessage(named('ParameterError', 'bad key sk_live_secret123'), 'confetti_events_find')
  assert.ok(!message.includes('sk_live_secret123'), 'api-key-shaped tokens must be redacted')
  assert.match(message, /\[redacted\]/)
})
