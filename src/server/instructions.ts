import Confetti from 'confetti'
import type { ModelDefinition } from 'confetti'
import {
  RESOURCE_MAP,
  includePathFor,
  listResourceOperations,
  type ModelKey,
  type Operation,
} from '../confetti/resource-map.js'
import type { GeneratedTool } from '../tools/definitions.js'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../tools/dispatch.js'
import { NOTES } from '../tools/notes.js'
import { toolName } from '../tools/names.js'

/**
 * The paragraph a client injects once, before it has read a single tool
 * description.
 *
 * What it is for: the 63 descriptions are islands. The resource tree
 * (workspaces -> events -> {pages -> blocks -> images, forms -> form fields,
 * tickets, …}) and the rule that reaches the seven resources with no list tool
 * are things a model currently discovers through two or three failed calls.
 *
 * How it is built: entirely from the same data the tools are generated from —
 * the registry's `relationships`, `listResourceOperations()`, `INCLUDE_PATHS`
 * and the `NOTES` table. Nothing here is a second copy of a fact stated
 * elsewhere: cross-tool rules are read out of `notes.ts`, which stays their one
 * home, and everything else is derived, so an upstream change moves this text
 * with it.
 *
 * It is regenerated per connection from that connection's *filtered* tool set,
 * so a `?resources=events` connection is told about events and nothing else,
 * and never cites a tool it cannot call.
 */

type Scope = Map<ModelKey, Set<Operation>>

const MODEL_ORDER = Object.keys(RESOURCE_MAP) as ModelKey[]
const MODEL_KEYS = new Set<string>(MODEL_ORDER)

const TOTAL_TOOLS = listResourceOperations().length

/** Operations that exist upstream, regardless of any connection's filter. */
const UPSTREAM_OPS: Scope = new Map()
for (const { modelKey, operation } of listResourceOperations()) {
  const set = UPSTREAM_OPS.get(modelKey) ?? new Set<Operation>()
  set.add(operation)
  UPSTREAM_OPS.set(modelKey, set)
}

function model(modelKey: ModelKey): ModelDefinition {
  return (Confetti.models as unknown as Record<ModelKey, ModelDefinition>)[modelKey]
}

/** `ticketBatches` -> `ticket batches`, for prose rather than for a tool name. */
function plural(modelKey: ModelKey): string {
  return RESOURCE_MAP[modelKey].replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
}

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** Resource names are lower-case; a sentence that starts with one is not. */
function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function scopeOf(tools: GeneratedTool[]): Scope {
  const scope: Scope = new Map()
  for (const tool of tools) {
    const set = scope.get(tool.modelKey) ?? new Set<Operation>()
    set.add(tool.operation)
    scope.set(tool.modelKey, set)
  }
  return scope
}

function inScopeKeys(scope: Scope): ModelKey[] {
  return MODEL_ORDER.filter((modelKey) => scope.has(modelKey))
}

function upstreamHas(modelKey: ModelKey, operation: Operation): boolean {
  return UPSTREAM_OPS.get(modelKey)?.has(operation) === true
}

/* ------------------------------------------------------------------ *
 * Citations
 * ------------------------------------------------------------------ */

/**
 * Instructions must never name a tool the connection does not have — that is
 * the one way this text can actively mislead. Applies to `NOTES` prose too,
 * including its `confetti_form_fields_*` style globs.
 */
function citesOnlyAvailableTools(text: string, available: Set<string>): boolean {
  for (const cited of text.match(/confetti_[a-z_]*?_(?:find_all|find|create|update|delete)\b/g) ?? []) {
    if (!available.has(cited)) return false
  }
  for (const glob of text.match(/confetti_[a-z_]+?_\*/g) ?? []) {
    const prefix = glob.slice(0, -1)
    if (![...available].some((name) => name.startsWith(prefix))) return false
  }
  return true
}

/* ------------------------------------------------------------------ *
 * Sections
 * ------------------------------------------------------------------ */

const OPENING =
  'These tools are the Confetti event-management API. Every call reads or writes live data in the workspace that this connection\'s API key belongs to; there is no sandbox.'

/** The first `belongsTo` that names another resource is the record's parent. */
function parentOf(modelKey: ModelKey): ModelKey | undefined {
  for (const relationship of model(modelKey).relationships ?? []) {
    if (relationship.type !== 'belongsTo') continue
    if (MODEL_KEYS.has(relationship.relationship)) return relationship.relationship as ModelKey
  }
  return undefined
}

/** Distance to the root, bounded so a cyclic registry cannot hang the build. */
function depthOf(modelKey: ModelKey): number {
  let depth = 0
  let current = parentOf(modelKey)
  while (current !== undefined && depth < MODEL_ORDER.length) {
    depth += 1
    current = parentOf(current)
  }
  return depth
}

/** The tree a model otherwise reverse-engineers from field names. */
function hierarchy(scope: Scope): string | undefined {
  const children = new Map<ModelKey, ModelKey[]>()
  for (const modelKey of inScopeKeys(scope)) {
    const parent = parentOf(modelKey)
    // An edge whose parent is not on this connection would name a resource the
    // caller cannot reach.
    if (!parent || !scope.has(parent)) continue
    children.set(parent, [...(children.get(parent) ?? []), modelKey])
  }
  if (children.size === 0) return undefined

  // Parents before their own children, so the tree reads top-down.
  const ordered = MODEL_ORDER.filter((modelKey) => children.has(modelKey)).sort(
    (left, right) => depthOf(left) - depthOf(right),
  )
  const branches = ordered.map(
    (parent) => `${plural(parent)} contain ${list((children.get(parent) ?? []).map(plural))}`,
  )
  return `How the records nest: ${branches.join('; ')}.`
}

function pagination(scope: Scope): string | undefined {
  const hasList = [...scope.values()].some((operations) => operations.has('findAll'))
  if (!hasList) return undefined
  return `Every list tool returns ONE page, as {returned, page, more, total, records}. The page size defaults to ${DEFAULT_PAGE_SIZE} and is capped at ${MAX_PAGE_SIZE}: read "more" (and "total" when the API sends it) before you treat a list as complete, and ask for the next page with page.number — never answer a counting question from a single page.`
}

/**
 * Seven resources have no list tool. Asked to "list the speakers", a model that
 * does not know this calls the event find tool with no `include` and reports
 * that there are none.
 */
function listless(scope: Scope, available: Set<string>): string | undefined {
  const missing = inScopeKeys(scope).filter(
    (modelKey) => !upstreamHas(modelKey, 'findAll') && scope.get(modelKey)?.has('find') === true,
  )
  if (missing.length === 0) return undefined

  const eventFind = toolName(RESOURCE_MAP['event'], 'find')
  const sentences: string[] = []

  const byPath = new Map<string, ModelKey[]>()
  const noPath: ModelKey[] = []
  for (const modelKey of missing) {
    const path = includePathFor(modelKey)
    if (path && available.has(eventFind)) byPath.set(path, [...(byPath.get(path) ?? []), modelKey])
    else noPath.push(modelKey)
  }

  if (byPath.size > 0) {
    const routes = [...byPath.entries()].map(
      ([path, keys]) => `${list(keys.map(plural))} with include: ["${path}"]`,
    )
    sentences.push(
      `There is no list tool for ${list(missing.map(plural))}. Enumerate ${list(routes)} on ${eventFind}.`,
    )
  } else {
    sentences.push(
      `There is no list tool for ${list(missing.map(plural))}; they can only be fetched by id.`,
    )
  }

  if (byPath.size > 0 && noPath.length > 0) {
    sentences.push(
      capitalise(`${list(noPath.map(plural))} appear in no include at all — keep the id their create call returns.`),
    )
  }
  return sentences.join(' ')
}

/**
 * Derived, not restated: *how* to take an event out of use is a cross-tool fact
 * that lives in notes.ts and reaches the model through the update tool.
 */
function undeletable(scope: Scope): string | undefined {
  const keys = inScopeKeys(scope).filter(
    (modelKey) =>
      !upstreamHas(modelKey, 'delete') &&
      (upstreamHas(modelKey, 'update') || upstreamHas(modelKey, 'create')),
  )
  if (keys.length === 0) return undefined

  const sentence = `No delete tool exists for ${list(keys.map(plural))}: the API cannot delete them.`
  // Only point at the update tool when this connection actually has one.
  const updatable = keys.some((modelKey) => scope.get(modelKey)?.has('update') === true)
  return updatable ? `${sentence} Their update tool documents what to do instead.` : sentence
}

/** Only for read-only resources notes.ts does not already speak for. */
function readOnly(scope: Scope): string | undefined {
  const keys = inScopeKeys(scope).filter((modelKey) => {
    const upstream = UPSTREAM_OPS.get(modelKey)
    const writable = upstream?.has('create') === true || upstream?.has('update') === true
    return !writable && NOTES[modelKey]?.['all'] === undefined
  })
  if (keys.length === 0) return undefined
  return `Read-only through this API: ${list(keys.map(plural))}.`
}

/**
 * The cross-tool facts, read out of `notes.ts` — their single home. Only the
 * resource-wide (`all`) entries: an operation-scoped note belongs to its tool's
 * description, where the model reads it in context.
 */
function crossToolFacts(scope: Scope, available: Set<string>): string | undefined {
  const facts = inScopeKeys(scope)
    .map((modelKey) => NOTES[modelKey]?.['all'])
    .filter((note): note is string => typeof note === 'string')
    .filter((note) => citesOnlyAvailableTools(note, available))
  return facts.length > 0 ? facts.join(' ') : undefined
}

function filterHint(tools: GeneratedTool[]): string | undefined {
  if (tools.length >= TOTAL_TOOLS) return undefined
  return `This connection exposes ${tools.length} of the ${TOTAL_TOOLS} Confetti tools; the rest are excluded by the ?ops= / ?resources= filter in its connect URL, and calling one of them will fail.`
}

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

export function buildInstructions(tools: GeneratedTool[]): string {
  if (tools.length === 0) return ''

  const scope = scopeOf(tools)
  const available = new Set(tools.map((tool) => tool.definition.name))

  const paragraphs = [
    [OPENING, hierarchy(scope)],
    [listless(scope, available), undeletable(scope), readOnly(scope)],
    [crossToolFacts(scope, available)],
    [pagination(scope)],
    [filterHint(tools)],
  ]

  return paragraphs
    .map((sentences) => sentences.filter((part): part is string => typeof part === 'string').join(' '))
    .filter((paragraph) => paragraph.length > 0)
    .join('\n\n')
}
