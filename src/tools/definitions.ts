import Confetti from 'confetti'
import { schemaToJsonSchema, filterToJsonSchema } from 'confetti'
import type { ModelDefinition } from 'confetti'
import {
  RESOURCE_MAP,
  includePathFor,
  listResourceOperations,
  type ModelKey,
  type Operation,
} from '../confetti/resource-map.js'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './dispatch.js'
import { toolName } from './names.js'
import { fieldDescription, notesFor } from './notes.js'

export interface JsonSchemaObject {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

export interface ToolAnnotations {
  title: string
  readOnlyHint: boolean
  openWorldHint: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: JsonSchemaObject
  annotations: ToolAnnotations
}

export interface GeneratedTool {
  definition: ToolDefinition
  modelKey: ModelKey
  operation: Operation
}

type Schema = Record<string, unknown>

/**
 * A single type, not `['string','number']`. The union is legal JSON Schema but
 * it is the one construct strict consumers refuse: ajv's strict mode will not
 * compile it, and hosts bridging to single-type function declarations drop the
 * parameter's typing or the whole tool. Numeric ids still work — they are
 * stringified into a URL path — so the fact is stated in prose instead.
 */
const ID_SCHEMA = {
  type: 'string',
  description: 'Record id. A number is accepted too.',
}

const PAGE_SCHEMA = {
  type: 'object',
  description: `JSON:API pagination. Defaults to a page size of ${DEFAULT_PAGE_SIZE}; sizes above ${MAX_PAGE_SIZE} are capped.`,
  properties: {
    number: { type: 'number', description: 'Page number, 1-based.' },
    size: { type: 'number' },
    offset: { type: 'number' },
    limit: { type: 'number' },
  },
}

const DATE_DESCRIPTION =
  'ISO 8601 date or date-time, e.g. "2026-09-01" or "2026-09-01T18:00:00Z".'

function isRecord(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function model(modelKey: ModelKey): ModelDefinition {
  return (Confetti.models as unknown as Record<ModelKey, ModelDefinition>)[modelKey]
}

/** `ticketBatches` -> `Ticket Batches`, `schedule-items` -> `Schedule Items`. */
function humanWords(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * Upstream `label` meta is a Title-Case echo of the field name for 131 of the
 * fields ("Rsvp Limit" for `rsvpLimit`). Shipping those as descriptions costs
 * context and tells a model nothing it cannot read off the key.
 */
function isLabelEcho(key: string, text: string): boolean {
  return text.trim().toLowerCase() === humanWords(key).toLowerCase()
}

/**
 * The tool surface must stay a flat object schema with real properties. zod's
 * `toJSONSchema` can emit `$defs`/`$ref` (reused or lazy sub-schemas) or a
 * non-object shape — the registry already contains one union-shaped model,
 * `previewToken`, that is merely unreachable today. Since only `properties`
 * and `required` survive the rebuild, either outcome would ship dangling
 * references or an empty tool, invisibly. Fail the build instead.
 */
export function assertObjectSchema(schema: unknown, label: string): asserts schema is Schema {
  if (!isRecord(schema) || schema['type'] !== 'object') {
    throw new Error(`${label}: expected a flat object JSON Schema, got ${JSON.stringify(schema)}`)
  }
  const properties = schema['properties']
  if (!isRecord(properties) || Object.keys(properties).length === 0) {
    throw new Error(`${label}: generated schema has no properties`)
  }
  if (JSON.stringify(schema).includes('$ref')) {
    throw new Error(`${label}: generated schema contains a $ref, which this server cannot ship`)
  }
}

/* ------------------------------------------------------------------ *
 * Cross-links: where does an id come from?
 * ------------------------------------------------------------------ */

const operationsByModel = new Map<ModelKey, Set<Operation>>()
for (const { modelKey, operation } of listResourceOperations()) {
  const set = operationsByModel.get(modelKey) ?? new Set<Operation>()
  set.add(operation)
  operationsByModel.set(modelKey, set)
}

function has(modelKey: ModelKey, operation: Operation): boolean {
  return operationsByModel.get(modelKey)?.has(operation) === true
}

function tool(modelKey: ModelKey, operation: Operation): string {
  return toolName(RESOURCE_MAP[modelKey], operation)
}

const MODEL_KEYS = new Set<string>(Object.keys(RESOURCE_MAP))

/** `eventId` -> `event`, but only when the prefix really names a resource. */
function referencedModel(field: string): ModelKey | undefined {
  const match = /^(.+)Id$/.exec(field)
  const prefix = match?.[1]
  return prefix !== undefined && MODEL_KEYS.has(prefix) ? (prefix as ModelKey) : undefined
}

/**
 * One sentence naming the tool that hands out this id. Purely mechanical: a
 * prefix that names no resource (`blockStyleId`, `themeId`, `sectionId`) gets
 * nothing rather than an invented tool name.
 */
function sourceOfId(field: string): string | undefined {
  const target = referencedModel(field)
  if (!target) return undefined
  if (has(target, 'findAll')) return `Obtain from ${tool(target, 'findAll')}.`
  const path = includePathFor(target)
  if (path) return `Obtain from ${tool('event', 'find')} with include: ["${path}"].`
  if (has(target, 'create')) return `Obtain from the ${tool(target, 'create')} response.`
  return undefined
}

/** Upstream helpText is not always punctuated; two sentences must not run on. */
function sentence(text: string): string {
  const trimmed = text.trim()
  return /[.!?)\]]$/.test(trimmed) ? trimmed : `${trimmed}.`
}

function append(property: Schema, next: string | undefined): void {
  if (!next) return
  const existing = typeof property['description'] === 'string' ? property['description'] : ''
  if (existing.includes(next)) return
  property['description'] = existing ? `${sentence(existing)} ${next}` : next
}

/* ------------------------------------------------------------------ *
 * Zod meta recovery
 * ------------------------------------------------------------------ */

interface ZodMeta {
  helpText?: unknown
  placeholder?: unknown
  values?: unknown
}

/** Zod v4 keeps `.meta()` on the schema instance, not in the JSON output. */
function metaOf(node: unknown): ZodMeta {
  if (typeof node !== 'object' || node === null) return {}
  const read = (node as { meta?: () => unknown }).meta
  if (typeof read !== 'function') return {}
  const meta = read.call(node)
  return isRecord(meta) ? meta : {}
}

function shapeOf(schema: unknown): Schema | undefined {
  const shape = (schema as { shape?: unknown } | undefined)?.shape
  return isRecord(shape) ? shape : undefined
}

/** `values` meta is either plain strings or `{value,label}` pairs. */
function enumValues(values: unknown): string[] | undefined {
  if (!Array.isArray(values) || values.length === 0) return undefined
  const mapped = values.map((entry) => {
    if (typeof entry === 'string') return entry
    if (isRecord(entry) && typeof entry['value'] === 'string') return entry['value']
    return undefined
  })
  return mapped.every((entry): entry is string => entry !== undefined) ? mapped : undefined
}

function branchesOf(property: Schema): Schema[] {
  const anyOf = property['anyOf']
  return Array.isArray(anyOf) ? anyOf.filter(isRecord) : []
}

/**
 * `z.union([z.iso.datetime(), z.string()])` serialises as
 * `anyOf:[{string,date-time},{string}]`, which advertises that any string at
 * all is a valid date. The bare branch carries no information the date-time
 * branch does not, so drop it and say in prose what the API really accepts —
 * a plain date as well as a full timestamp.
 */
function collapseDateUnion(property: Schema): void {
  const branches = branchesOf(property)
  if (branches.length < 2) return
  const dateTime = branches.find(
    (branch) => branch['type'] === 'string' && branch['format'] === 'date-time',
  )
  if (!dateTime) return
  const kept = branches.filter(
    (branch) => branch === dateTime || branch['type'] !== 'string' || branch['enum'] !== undefined,
  )
  if (kept.length === branches.length) return

  if (kept.length === 1) {
    delete property['anyOf']
    property['type'] = 'string'
    property['format'] = 'date-time'
  } else {
    property['anyOf'] = kept
  }
  append(property, DATE_DESCRIPTION)
}

/**
 * `schemaToJsonSchema` deletes `label`, `helpText`, `placeholder` and `values`
 * from its output, so hand-written upstream documentation — including the only
 * statement of which values a field accepts — never reaches the model. Walk the
 * Zod shape alongside the generated schema and put it back.
 *
 * Fill-gaps-only: an upstream `description` always wins, and the recovered text
 * is only ever added where there was nothing.
 */
/**
 * Every webhook event type the registry knows about, gathered from the
 * `webhooks` array each model carries.
 *
 * `webhook.type` is declared upstream as a bare string, so nothing in the
 * schema tells a caller that only these 17 values are accepted — but the
 * registry states them, one model at a time. Generating the enum keeps it
 * correct as upstream adds events, where a hand-written list would rot.
 */
function webhookEventTypes(): string[] {
  const registry = Confetti.models as unknown as Record<string, ModelDefinition>
  const types = new Set<string>()
  for (const model of Object.values(registry)) {
    for (const hook of model.webhooks ?? []) types.add(hook.type)
  }
  return [...types].sort()
}

function enrichFromZodMeta(modelKey: ModelKey, shape: Schema | undefined, json: Schema): void {
  const properties = json['properties']
  if (!isRecord(properties)) return

  // Only `webhook.type`: the values live in the registry rather than the schema.
  if (modelKey === 'webhook') {
    const type = properties['type']
    if (isRecord(type) && type['enum'] === undefined && type['type'] === 'string') {
      const types = webhookEventTypes()
      if (types.length > 0) type['enum'] = types
    }
  }

  for (const [field, node] of Object.entries(properties)) {
    if (!isRecord(node)) continue
    const property = node

    collapseDateUnion(property)

    const meta = metaOf(shape?.[field])
    if (typeof property['description'] !== 'string' || property['description'] === '') {
      const helpText = typeof meta.helpText === 'string' ? sentence(meta.helpText) : ''
      // `phone` carries both an "Example: +46701234567" helpText and a
      // +46 12 345 67 89 placeholder; shipping both says the same thing twice.
      const placeholder =
        typeof meta.placeholder === 'string' && !/example/i.test(helpText)
          ? `Example: ${meta.placeholder}`
          : ''
      const extra = [helpText, placeholder].filter((part) => part.length > 0).join(' ')
      if (extra) property['description'] = extra
    }

    const values = enumValues(meta.values)
    if (values) {
      const bare = branchesOf(property).find(
        (branch) => branch['type'] === 'string' && branch['enum'] === undefined,
      )
      if (bare) bare['enum'] = values
      else if (property['type'] === 'string' && property['enum'] === undefined) {
        property['enum'] = values
      }
    }

    const override = fieldDescription(modelKey, field)
    if (override) property['description'] = override

    append(property, sourceOfId(field))
  }
}

/* ------------------------------------------------------------------ *
 * Schemas
 * ------------------------------------------------------------------ */

function sampleOf(m: ModelDefinition): string {
  const sample = m.sample?.single?.formatted
  // Compact on purpose: pretty-printing the same record costs ~30% more
  // context for nothing.
  return sample ? `\n\nExample record: ${JSON.stringify(sample)}` : ''
}

function findAllSchema(m: ModelDefinition, modelKey: ModelKey): JsonSchemaObject {
  const properties: Record<string, unknown> = {}
  const requiredFilters: string[] = []

  const filterEntries = Object.entries(m.filters)
  if (filterEntries.length > 0) {
    const filterProps: Record<string, unknown> = {}
    for (const [key, filter] of filterEntries) {
      const generated = filterToJsonSchema(filter) as unknown as Schema

      // An `enum` on the array itself means the array instance must equal one
      // of the strings — unsatisfiable by any value. The values describe the
      // items, so that is where they belong.
      if (generated['type'] === 'array' && Array.isArray(generated['enum'])) {
        generated['items'] = { type: 'string', enum: generated['enum'] }
        delete generated['enum']
      }

      const label = generated['description']
      if (typeof label === 'string' && isLabelEcho(key, label)) delete generated['description']
      append(generated, sourceOfId(key))

      filterProps[key] = generated
      if (filter.required === true) requiredFilters.push(key)
    }
    properties['filter'] = {
      type: 'object',
      description: `Filters for ${m.name} records.`,
      properties: filterProps,
      // tickets, payments and ticketBatches parse `filter.eventId` upstream
      // before any request goes out, so a schema-conformant `{}` call could
      // only ever fail. Advertise what is actually enforced.
      ...(requiredFilters.length > 0 ? { required: requiredFilters } : {}),
    }
  }

  if (m.sorting.length > 0) {
    properties['sort'] = {
      type: 'string',
      description: 'Field to sort by. Prefix with "-" for descending order.',
      enum: m.sorting,
    }
  }

  if (m.includes.length > 0) {
    properties['include'] = {
      type: 'array',
      description: 'Related resources to side-load into the response.',
      items: { type: 'string', enum: m.includes },
    }
  }

  properties['page'] = PAGE_SCHEMA

  const schema: JsonSchemaObject = { type: 'object', properties }
  if (requiredFilters.length > 0) schema.required = ['filter']
  assertObjectSchema(schema, `${modelKey}.findAll`)
  return schema
}

function findSchema(m: ModelDefinition): JsonSchemaObject {
  const properties: Record<string, unknown> = { id: ID_SCHEMA }
  if (m.includes.length > 0) {
    properties['include'] = {
      type: 'array',
      description: 'Related resources to side-load into the response.',
      items: { type: 'string', enum: m.includes },
    }
  }
  return { type: 'object', properties, required: ['id'] }
}

function bodySchema(
  m: ModelDefinition,
  modelKey: ModelKey,
  operation: 'create' | 'update',
): JsonSchemaObject {
  const config = m.operations[operation]
  if (!config) throw new Error(`models.${modelKey}.operations.${operation} is missing`)
  // Deliberately NOT stripping relationship fields: workspaceId and friends
  // must stay settable, or records cannot be attached to their parent.
  const generated = schemaToJsonSchema(config.schema) as unknown as Schema
  assertObjectSchema(generated, `${modelKey}.${operation}`)
  enrichFromZodMeta(modelKey, shapeOf(config.schema), generated)

  const properties = generated['properties'] as Record<string, unknown>
  const required = generated['required']
  return {
    type: 'object',
    properties: { ...properties },
    ...(Array.isArray(required) ? { required: [...(required as string[])] } : {}),
  }
}

function updateSchema(m: ModelDefinition, modelKey: ModelKey): JsonSchemaObject {
  const body = bodySchema(m, modelKey, 'update')
  return {
    type: 'object',
    properties: { id: ID_SCHEMA, ...body.properties },
    // Only the identifier is required. A partial update must never mandate
    // fields beyond it — inheriting the body schema's required list would force
    // callers to resupply fields they aren't changing. test/tools/definitions.ts
    // pins that no upstream update schema has required fields, so this promise
    // cannot quietly diverge from what `confetti` enforces.
    required: ['id'],
  }
}

function deleteSchema(): JsonSchemaObject {
  return { type: 'object', properties: { id: ID_SCHEMA }, required: ['id'] }
}

function schemaFor(m: ModelDefinition, modelKey: ModelKey, operation: Operation): JsonSchemaObject {
  switch (operation) {
    case 'findAll':
      return findAllSchema(m, modelKey)
    case 'find':
      return findSchema(m)
    case 'create':
      return bodySchema(m, modelKey, 'create')
    case 'update':
      return updateSchema(m, modelKey)
    case 'delete':
      return deleteSchema()
  }
}

/* ------------------------------------------------------------------ *
 * Descriptions
 * ------------------------------------------------------------------ */

/**
 * How to reach a resource that has no list tool. Without this a model asked to
 * "list the speakers" finds no `speakers_find_all`, calls `events_find` with no
 * `include`, and reports that the event has none.
 */
function breadcrumb(modelKey: ModelKey, m: ModelDefinition, plural: string): string | undefined {
  if (has(modelKey, 'findAll')) return undefined
  const path = includePathFor(modelKey)
  if (path) {
    return `No list tool for ${plural}: enumerate them with ${tool('event', 'find')}, include: ["${path}"].`
  }
  if (has(modelKey, 'create')) {
    return `No list tool for ${plural} and no event include: keep the id from ${tool(modelKey, 'create')}.`
  }
  return `No list tool for ${plural}: a ${m.name} can only be fetched by id.`
}

/** `Belongs to: event (eventId)`, for the parents this body can actually set. */
function belongsTo(m: ModelDefinition, properties: Record<string, unknown>): string | undefined {
  const parents = (m.relationships ?? [])
    .filter((relationship) => relationship.type === 'belongsTo' && relationship.field in properties)
    .map((relationship) => `${relationship.relationship} (${relationship.field})`)
  return parents.length > 0 ? `Belongs to: ${parents.join(', ')}.` : undefined
}

function describe(
  m: ModelDefinition,
  modelKey: ModelKey,
  operation: Operation,
  schema: JsonSchemaObject,
): string {
  const noun = m.name
  const plural = humanWords(RESOURCE_MAP[modelKey])
  const parts: string[] = []

  switch (operation) {
    case 'findAll':
      parts.push(`List ${plural} from Confetti.`)
      if (schema.required?.includes('filter')) {
        const filter = schema.properties['filter'] as { required?: string[] }
        const keys = (filter.required ?? []).map((key) => `filter.${key}`)
        parts.push(`Required: ${keys.join(', ')}.`)
      }
      break
    case 'find':
      parts.push(`Fetch a single ${noun} from Confetti by id.`)
      break
    case 'create': {
      parts.push(`Create a new ${noun} in Confetti.`)
      if (schema.required && schema.required.length > 0) {
        parts.push(`Required: ${schema.required.join(', ')}.`)
      }
      const parents = belongsTo(m, schema.properties)
      if (parents) parts.push(parents)
      break
    }
    case 'update':
      parts.push(
        `Update an existing ${noun} in Confetti by id. Pass only the fields you want to change.`,
      )
      break
    case 'delete':
      parts.push(`Permanently delete a ${noun} from Confetti by id. This cannot be undone.`)
      break
  }

  const trail = breadcrumb(modelKey, m, plural)
  if (trail) parts.push(trail)
  parts.push(...notesFor(modelKey, operation))

  // The sample is the single most expensive thing in the tool list, so ship it
  // once per resource: on the list tool where there is one, otherwise on find —
  // seven resources have no list tool and it is their only shape documentation.
  const carriesSample = has(modelKey, 'findAll') ? operation === 'findAll' : operation === 'find'
  if (carriesSample) return parts.join(' ') + sampleOf(m)
  if (operation === 'find' && has(modelKey, 'findAll')) {
    parts.push(`Returns the same record shape as ${tool(modelKey, 'findAll')}.`)
  }
  return parts.join(' ')
}

const TITLE_VERBS: Record<Operation, string> = {
  findAll: 'List',
  find: 'Get',
  create: 'Create',
  update: 'Update',
  delete: 'Delete',
}

function annotate(m: ModelDefinition, modelKey: ModelKey, operation: Operation): ToolAnnotations {
  const readOnly = operation === 'find' || operation === 'findAll'
  const subject = operation === 'findAll' ? humanWords(RESOURCE_MAP[modelKey]) : m.name
  return {
    // A human title, not the machine name: hosts show this in approval dialogs
    // and tool pickers, where `confetti_sponsor_levels_delete` is noise.
    title: `${TITLE_VERBS[operation]} ${subject}`,
    readOnlyHint: readOnly,
    // Every tool talks to one closed API. The spec's default is `true`, which
    // would claim these calls could reach anywhere.
    openWorldHint: false,
    ...(operation === 'delete' ? { destructiveHint: true } : {}),
    ...(operation === 'update' || operation === 'delete' ? { idempotentHint: true } : {}),
    ...(operation === 'create' ? { destructiveHint: false } : {}),
  }
}

export function buildTools(): GeneratedTool[] {
  return listResourceOperations().map(({ modelKey, resourceName, operation }) => {
    const m = model(modelKey)
    const name = toolName(resourceName, operation)
    const inputSchema = schemaFor(m, modelKey, operation)
    return {
      modelKey,
      operation,
      definition: {
        name,
        description: describe(m, modelKey, operation, inputSchema),
        inputSchema,
        annotations: annotate(m, modelKey, operation),
      },
    }
  })
}
