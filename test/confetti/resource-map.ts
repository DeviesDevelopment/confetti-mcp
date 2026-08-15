import { test } from 'node:test'
import assert from 'node:assert/strict'
import Confetti from 'confetti'
import {
  INCLUDE_PATHS,
  RESOURCE_MAP,
  includePathFor,
  listResourceOperations,
} from '../../src/confetti/resource-map.js'

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

test('every include path is a path the event model really side-loads', () => {
  const includes = new Set((Confetti.models.event as unknown as { includes: string[] }).includes)
  for (const [modelKey, path] of Object.entries(INCLUDE_PATHS)) {
    assert.ok(
      includes.has(path),
      `INCLUDE_PATHS.${modelKey} = "${path}" is not in Confetti.models.event.includes — the breadcrumb would send models down a dead path`,
    )
  }
})

test('include paths exist only for resources that have no list tool', () => {
  const withFindAll = new Set(
    listResourceOperations()
      .filter(({ operation }) => operation === 'findAll')
      .map(({ modelKey }) => modelKey),
  )
  for (const modelKey of Object.keys(INCLUDE_PATHS)) {
    assert.ok(modelKey in RESOURCE_MAP, `INCLUDE_PATHS.${modelKey} names no mapped resource`)
    assert.ok(
      !withFindAll.has(modelKey as keyof typeof RESOURCE_MAP),
      `${modelKey} has a find_all tool; the include breadcrumb is misleading`,
    )
  }
})

test('the list-less resources are exactly the ones we expect', () => {
  const withFindAll = new Set(
    listResourceOperations()
      .filter(({ operation }) => operation === 'findAll')
      .map(({ modelKey }) => modelKey),
  )
  const listless = Object.keys(RESOURCE_MAP).filter(
    (modelKey) => !withFindAll.has(modelKey as keyof typeof RESOURCE_MAP),
  )
  assert.deepEqual(listless, [
    'form',
    'formField',
    'speaker',
    'organiser',
    'scheduleItem',
    'sponsor',
    'sponsorLevel',
  ])
  // sponsor and sponsorLevel appear in no event include: their ids can only
  // come from a create response, and pretending otherwise would be a lie.
  assert.equal(includePathFor('sponsor'), undefined)
  assert.equal(includePathFor('sponsorLevel'), undefined)
  assert.equal(includePathFor('speaker'), 'speakers')
  assert.equal(includePathFor('event'), undefined)
})

test('every create/update operation has a schema in the registry', () => {
  for (const { modelKey, operation } of listResourceOperations()) {
    if (operation !== 'create' && operation !== 'update') continue
    const model = (Confetti.models as unknown as Record<string, { operations: Record<string, unknown> }>)[modelKey]
    assert.ok(model?.operations[operation], `models.${modelKey}.operations.${operation} is missing`)
  }
})
