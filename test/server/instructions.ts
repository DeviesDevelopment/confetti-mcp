import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildInstructions } from '../../src/server/instructions.js'
import { buildTools } from '../../src/tools/definitions.js'
import { parseToolFilter, selectTools } from '../../src/tools/filter.js'

const ALL = buildTools()

function scoped(query: Record<string, unknown>) {
  return selectTools(ALL, parseToolFilter(query))
}

test('orients a model in the resource tree it would otherwise reverse-engineer', () => {
  const text = buildInstructions(ALL)

  assert.match(text, /workspace/i)
  assert.match(text, /events/i)
  // The hierarchy is the thing that costs 2-3 failed calls to discover.
  assert.match(text, /pages/i)
  assert.match(text, /blocks/i)
})

test('states the pagination contract, which no tool description states', () => {
  const text = buildInstructions(ALL)

  assert.match(text, /25/, 'the default page size')
  assert.match(text, /100/, 'the cap this server applies')
  assert.match(text, /more/, 'the envelope field that says whether anything is left')
})

test('routes the list-less resources through the include that reaches them', () => {
  const text = buildInstructions(ALL)

  // Asked to "list the speakers", a model with no tool for it calls
  // events_find without include and reports there are none.
  assert.match(text, /speakers/i)
  assert.match(text, /forms\.form-fields/)
  assert.match(text, /confetti_events_find/)
})

test('names the resources that cannot be deleted through the API', () => {
  const text = buildInstructions(ALL)
  assert.match(text, /events[^.]*cannot be deleted|no delete tool[^.]*events/i)
})

test('carries the cross-tool facts from notes.ts rather than restating them', () => {
  const text = buildInstructions(ALL)
  // Verbatim from NOTES.ticket.all — one home for the fact, two renderings.
  assert.match(text, /Workspace-level people are Contacts/)
  assert.match(text, /Payments are read-only/)
})

test('is scoped to the connection: a resources=events connection hears nothing about tickets', () => {
  const text = buildInstructions(scoped({ resources: 'events' }))

  assert.match(text, /events/i)
  assert.ok(!/tickets/i.test(text), 'a scoped connection must not be told about tools it does not have')
  assert.ok(!/speakers/i.test(text), 'nor about resources it cannot reach')
  assert.ok(!/Payments are read-only/.test(text))
})

test('says so when the connect URL has narrowed the tool set', () => {
  const full = buildInstructions(ALL)
  const readOnly = buildInstructions(scoped({ ops: 'read' }))

  assert.match(readOnly, /\?ops=|\?resources=/, 'a filtered connection should know why tools are missing')
  assert.ok(!/\?ops=/.test(full), 'an unfiltered connection needs no such note')
})

test('every tool it names exists on that connection', () => {
  for (const query of [{}, { ops: 'read' }, { resources: 'events,pages' }, { resources: 'speakers' }]) {
    const tools = scoped(query)
    const names = new Set(tools.map((tool) => tool.definition.name))
    const text = buildInstructions(tools)
    for (const cited of text.match(/confetti_[a-z_]*?_(?:find_all|find|create|update|delete)\b/g) ?? []) {
      assert.ok(names.has(cited), `${cited} is cited for ${JSON.stringify(query)} but is not on that connection`)
    }
  }
})

test('stays a short orientation, not a second copy of the tool list', () => {
  const text = buildInstructions(ALL)
  assert.ok(text.length < 2500, `instructions are ${text.length} chars; this is charged once per session`)
  assert.ok(text.length > 300, 'an empty orientation helps nobody')
})

test('an empty tool set produces no instructions at all', () => {
  assert.equal(buildInstructions([]), '')
})
