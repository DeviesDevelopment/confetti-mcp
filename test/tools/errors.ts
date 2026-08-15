import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { toolErrorMessage } from '../../src/tools/errors.js'

function named(name: string, message: string, extra: Record<string, unknown> = {}): Error {
  const error = new Error(message)
  error.name = name
  return Object.assign(error, extra)
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
  assert.ok(
    !/could not be reached/.test(message),
    'a bug in this process must not be dressed up as a network failure',
  )
})

test('a real network failure says so and asks for one retry', () => {
  const message = toolErrorMessage(named('FetchError', 'request to https://api.confetti.events failed, reason: ECONNRESET'), 'confetti_events_find_all')
  assert.match(message, /could not be reached/)
  assert.match(message, /Retry once/)
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

test('redacts the caller api key exactly, whatever its shape', () => {
  const message = toolErrorMessage(named('ParameterError', 'rejected key my-key here'), 'confetti_events_find', 'my-key')
  assert.ok(!message.includes('my-key'), 'the caller key must not survive into the message')
  assert.match(message, /\[redacted\]/)
})

test('redacts every occurrence of the caller api key', () => {
  const message = toolErrorMessage(named('ParameterError', 'my-key then my-key again'), 'confetti_events_find', 'my-key')
  assert.ok(!message.includes('my-key'))
})

test('redacts the caller key even from an unclassified error', () => {
  const message = toolErrorMessage(named('TypeError', 'boom my-key'), 'confetti_events_find', 'my-key')
  assert.ok(!message.includes('my-key'))
  assert.match(message, /\[TypeError\]/)
})

test('an empty or trivially short secret does not corrupt the message', () => {
  assert.match(toolErrorMessage(named('ParameterError', 'plain failure'), 'confetti_events_find', ''), /plain failure/)
  assert.match(toolErrorMessage(named('ParameterError', 'plain failure'), 'confetti_events_find', 'ab'), /plain failure/)
})

/* ------------------------------------------------------------------ *
 * The upstream error body
 * ------------------------------------------------------------------ */

test('harvests the JSON:API error body a ParameterError carries', () => {
  // confetti's adapter throws `new ParameterError(errorText || 'validation', body)`,
  // and errorText is undefined for a JSON body: without harvesting, the whole
  // message a model gets is the single word "validation".
  const error = named('ParameterError', 'validation', {
    errors: [{ detail: 'eventId must be an integer', source: { pointer: '/data/attributes/eventId' } }],
  })
  const message = toolErrorMessage(error, 'confetti_tickets_create')
  assert.match(message, /Invalid parameters for 'confetti_tickets_create'/)
  assert.match(message, /eventId must be an integer/)
})

test('harvests the body of a NotFoundError too', () => {
  const error = named('NotFoundError', 'Not found', { detail: 'no event with id 999 in this workspace' })
  const message = toolErrorMessage(error, 'confetti_events_find')
  assert.match(message, /no event with id 999 in this workspace/)
})

test('the harvested body never carries the api key out', () => {
  const error = named('ParameterError', 'validation', { errors: [{ detail: 'bad key my-secret-key' }] })
  const message = toolErrorMessage(error, 'confetti_events_find', 'my-secret-key')
  assert.ok(!message.includes('my-secret-key'), 'the harvested body must go through redact()')
  assert.match(message, /\[redacted\]/)
})

test('does not echo the error plumbing as if it were upstream detail', () => {
  const error = named('ParameterError', 'validation', { errors: [{ detail: 'nope' }] })
  const message = toolErrorMessage(error, 'confetti_events_find')
  assert.ok(!message.includes('stack'), 'stack must never be harvested')
  // `errorType` is confetti's own copy of the message; echoing it says it twice.
  assert.ok(!/errorType/.test(message))
})

/* ------------------------------------------------------------------ *
 * ZodError issues
 * ------------------------------------------------------------------ */

test('renders ZodError issues one line each instead of the pretty-printed array', () => {
  const error = named('ZodError', 'ignored pretty-printed blob', {
    issues: [
      { code: 'invalid_type', path: ['filter', 'eventId'], message: 'Invalid input: expected number, received undefined' },
      { code: 'invalid_type', path: ['name'], message: 'Invalid input: expected string, received number' },
    ],
  })
  const message = toolErrorMessage(error, 'confetti_tickets_find_all')
  assert.match(message, /Invalid parameters for 'confetti_tickets_find_all'/)
  assert.match(message, /filter\.eventId: required field is missing/)
  assert.match(message, /name: .*expected string, received number/)
  assert.ok(
    !message.includes('ignored pretty-printed blob'),
    'the issues array replaces the pretty-printed message, it does not join it',
  )
})

test('collapses an invalid_union issue to the branches it accepts', () => {
  const error = named('ZodError', 'blob', {
    issues: [
      {
        code: 'invalid_union',
        path: ['startDate'],
        message: 'Invalid input',
        errors: [
          [{ code: 'invalid_format', format: 'datetime', expected: 'ISO datetime', path: [], message: 'Invalid ISO datetime' }],
          [{ code: 'invalid_type', expected: 'number', path: [], message: 'Invalid input: expected number' }],
        ],
      },
    ],
  })
  const message = toolErrorMessage(error, 'confetti_events_create')
  assert.match(message, /startDate/)
  assert.match(message, /ISO datetime/)
  assert.match(message, /number/)
  assert.ok(!/^.*Invalid input$/m.test(message), 'a bare "Invalid input" tells the model nothing')
})

test('bounds a pathological issue list instead of shipping hundreds of lines', () => {
  const issues = Array.from({ length: 40 }, (_value, index) => ({
    code: 'invalid_type',
    path: [`field${index}`],
    message: 'Invalid input: expected string, received number',
  }))
  const message = toolErrorMessage(named('ZodError', 'blob', { issues }), 'confetti_events_create')
  assert.ok(message.split('\n').length <= 14, `expected a bounded list, got ${message.split('\n').length} lines`)
  assert.match(message, /more/)
})

test('does not import zod to read the issues', () => {
  // zod is a transitive dependency of confetti only; importing it here would
  // pin a second copy against the version that threw.
  const source = readFileSync(new URL('../../src/tools/errors.ts', import.meta.url), 'utf8')
  assert.ok(!/from '.*\bzod\b.*'/.test(source), 'errors.ts must duck-type the issues array')
})

/* ------------------------------------------------------------------ *
 * Bare HTTP statuses
 * ------------------------------------------------------------------ */

test('maps HTTP 401 to key guidance rather than a retry', () => {
  const message = toolErrorMessage(named('Error', 'HTTP 401'), 'confetti_events_find_all')
  assert.match(message, /key/i)
  assert.match(message, /not retry|no retry|do not retry/i)
})

test('maps HTTP 500 to the invalid-key-first guidance, with no retry loop', () => {
  // Live-verified: api.confetti.events answers 500, not 401, for a bad key.
  const message = toolErrorMessage(named('Error', 'HTTP 500'), 'confetti_events_find_all')
  assert.match(message, /invalid API key|key is likely wrong|key/i)
  assert.match(message, /do not loop|not in a loop/i)
})

test('maps HTTP 429 to waiting before a retry', () => {
  const message = toolErrorMessage(named('Error', 'HTTP 429'), 'confetti_events_find_all')
  assert.match(message, /rate|wait/i)
})

test('maps HTTP 503 to one retry', () => {
  const message = toolErrorMessage(named('Error', 'HTTP 503'), 'confetti_events_find_all')
  assert.match(message, /retry once|transient/i)
})

test('leaves a message that merely contains a status untouched by the mapper', () => {
  const message = toolErrorMessage(named('Error', 'the vendor said HTTP 500 was fine'), 'confetti_events_find_all')
  assert.ok(!/invalid API key/i.test(message), 'only a bare "HTTP nnn" is a status this server can classify')
})

/* ------------------------------------------------------------------ *
 * Upstream timeout
 * ------------------------------------------------------------------ */

test('an upstream timeout reads as a timeout, not as invalid parameters', () => {
  // dispatch names the deadline rejection ParameterError so it reaches the
  // caller as an actionable message; the code is what identifies it.
  const error = named('ParameterError', "'confetti_events_find_all' gave up waiting for the Confetti API after 25000 ms. Retry once.", {
    code: 'UPSTREAM_TIMEOUT',
    timeoutMs: 25_000,
  })
  const message = toolErrorMessage(error, 'confetti_events_find_all')
  assert.match(message, /timed out|timeout/i)
  assert.ok(!/Invalid parameters/.test(message), 'a timeout is not a parameter problem')
  assert.match(message, /25000 ms/, 'quote the real deadline, not a number from the package')
})
