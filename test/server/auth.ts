import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractApiKey } from '../../src/server/auth.js'

test('reads Authorization Bearer header', () => {
  assert.equal(extractApiKey({ headers: { authorization: 'Bearer sk_abc' } }), 'sk_abc')
})

test('Bearer scheme is case-insensitive', () => {
  assert.equal(extractApiKey({ headers: { authorization: 'bearer sk_abc' } }), 'sk_abc')
})

test('reads X-Api-Key header', () => {
  assert.equal(extractApiKey({ headers: { 'x-api-key': 'sk_xyz' } }), 'sk_xyz')
})

test('reads apiKey path param', () => {
  assert.equal(extractApiKey({ headers: {}, params: { apiKey: 'sk_path' } }), 'sk_path')
})

test('Authorization wins over X-Api-Key, query, and path', () => {
  const key = extractApiKey({
    headers: { authorization: 'Bearer sk_header', 'x-api-key': 'sk_alias' },
    query: { apiKey: 'sk_query' },
    params: { apiKey: 'sk_path' },
  })
  assert.equal(key, 'sk_header')
})

test('X-Api-Key wins over path', () => {
  const key = extractApiKey({ headers: { 'x-api-key': 'sk_alias' }, params: { apiKey: 'sk_path' } })
  assert.equal(key, 'sk_alias')
})

test('returns undefined when absent', () => {
  assert.equal(extractApiKey({ headers: {} }), undefined)
})

test('returns undefined for a Bearer header with no token', () => {
  assert.equal(extractApiKey({ headers: { authorization: 'Bearer ' } }), undefined)
})

test('ignores a non-Bearer Authorization scheme', () => {
  assert.equal(extractApiKey({ headers: { authorization: 'Basic dXNlcjpwYXNz' } }), undefined)
})

test('trims surrounding whitespace', () => {
  assert.equal(extractApiKey({ headers: { 'x-api-key': '  sk_pad  ' } }), 'sk_pad')
})

test('reads apiKey query parameter', () => {
  assert.equal(extractApiKey({ headers: {}, query: { apiKey: 'sk_query' } }), 'sk_query')
})

test('X-Api-Key wins over the query parameter', () => {
  const key = extractApiKey({ headers: { 'x-api-key': 'sk_alias' }, query: { apiKey: 'sk_query' } })
  assert.equal(key, 'sk_alias')
})

test('query parameter wins over the path param', () => {
  const key = extractApiKey({ headers: {}, query: { apiKey: 'sk_query' }, params: { apiKey: 'sk_path' } })
  assert.equal(key, 'sk_query')
})

test('a repeated apiKey query parameter takes the first value', () => {
  assert.equal(extractApiKey({ headers: {}, query: { apiKey: ['sk_one', 'sk_two'] } }), 'sk_one')
})

test('an empty apiKey query parameter falls through to the path param', () => {
  const key = extractApiKey({ headers: {}, query: { apiKey: '  ' }, params: { apiKey: 'sk_path' } })
  assert.equal(key, 'sk_path')
})
