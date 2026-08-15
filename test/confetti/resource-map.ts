import { test } from 'node:test'
import assert from 'node:assert/strict'
import Confetti from 'confetti'
import { RESOURCE_MAP, listResourceOperations } from '../../src/confetti/resource-map.js'

const STATIC_EXCLUDES = new Set(['length', 'name', 'prototype', 'models'])

function staticResourceNames(): string[] {
  return Object.getOwnPropertyNames(Confetti).filter((k) => !STATIC_EXCLUDES.has(k))
}

test('every mapped resource name exists on Confetti', () => {
  for (const [modelKey, resourceName] of Object.entries(RESOURCE_MAP)) {
    const resource = (Confetti as unknown as Record<string, unknown>)[resourceName]
    assert.ok(resource, `${modelKey} -> Confetti.${resourceName} is missing`)
  }
})

test('every static resource on Confetti is mapped', () => {
  const mapped = new Set(Object.values(RESOURCE_MAP))
  for (const name of staticResourceNames()) {
    assert.ok(mapped.has(name), `Confetti.${name} is not in RESOURCE_MAP`)
  }
})

test('every mapped model key exists in Confetti.models', () => {
  for (const modelKey of Object.keys(RESOURCE_MAP)) {
    assert.ok(modelKey in Confetti.models, `models.${modelKey} is missing`)
  }
})

test('maps exactly 18 resources', () => {
  assert.equal(Object.keys(RESOURCE_MAP).length, 18)
})

test('enumerates exactly 63 operations', () => {
  assert.equal(listResourceOperations().length, 63)
})

test('operation counts per verb match the spec', () => {
  const byVerb = listResourceOperations().reduce<Record<string, number>>((acc, op) => {
    acc[op.operation] = (acc[op.operation] ?? 0) + 1
    return acc
  }, {})
  assert.deepEqual(byVerb, { find: 18, findAll: 11, create: 13, update: 11, delete: 10 })
})

test('every create/update operation has a schema in the registry', () => {
  for (const { modelKey, operation } of listResourceOperations()) {
    if (operation !== 'create' && operation !== 'update') continue
    const model = (Confetti.models as unknown as Record<string, { operations: Record<string, unknown> }>)[modelKey]
    assert.ok(model?.operations[operation], `models.${modelKey}.operations.${operation} is missing`)
  }
})
