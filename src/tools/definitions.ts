import Confetti from 'confetti'
import { schemaToJsonSchema, filterToJsonSchema } from 'confetti'
import type { ModelDefinition } from 'confetti'
import { listResourceOperations, type ModelKey, type Operation } from '../confetti/resource-map.js'
import { toolName } from './names.js'

export interface JsonSchemaObject {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

export interface ToolAnnotations {
  title: string
  readOnlyHint: boolean
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

const ID_SCHEMA = { type: ['string', 'number'], description: 'Identifier of the record.' }

const PAGE_SCHEMA = {
  type: 'object',
  description: 'JSON:API pagination. Defaults to a page size of 25 when omitted.',
  properties: {
    number: { type: 'number', description: 'Page number, 1-based.' },
    size: { type: 'number', description: 'Records per page. Defaults to 25.' },
    offset: { type: 'number' },
    limit: { type: 'number' },
  },
}

function model(modelKey: ModelKey): ModelDefinition {
  return (Confetti.models as unknown as Record<ModelKey, ModelDefinition>)[modelKey]
}

function sampleFor(m: ModelDefinition): string {
  const sample = m.sample?.single?.formatted
  if (!sample) return ''
  return `\n\nExample record:\n${JSON.stringify(sample, null, 2)}`
}

function findAllSchema(m: ModelDefinition): JsonSchemaObject {
  const properties: Record<string, unknown> = {}

  const filterKeys = Object.keys(m.filters)
  if (filterKeys.length > 0) {
    const filterProps: Record<string, unknown> = {}
    for (const [key, filter] of Object.entries(m.filters)) {
      filterProps[key] = filterToJsonSchema(filter)
    }
    properties['filter'] = {
      type: 'object',
      description: `Filters for ${m.name} records.`,
      properties: filterProps,
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

  return { type: 'object', properties }
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

function bodySchema(m: ModelDefinition, operation: 'create' | 'update'): JsonSchemaObject {
  const config = m.operations[operation]
  if (!config) throw new Error(`models.${m.key}.operations.${operation} is missing`)
  // Deliberately NOT stripping relationship fields: workspaceId and friends
  // must stay settable, or records cannot be attached to their parent.
  const generated = schemaToJsonSchema(config.schema) as unknown as JsonSchemaObject
  return {
    type: 'object',
    properties: { ...generated.properties },
    ...(generated.required ? { required: [...generated.required] } : {}),
  }
}

function updateSchema(m: ModelDefinition): JsonSchemaObject {
  const body = bodySchema(m, 'update')
  return {
    type: 'object',
    properties: { id: ID_SCHEMA, ...body.properties },
    required: ['id', ...(body.required ?? [])],
  }
}

function deleteSchema(): JsonSchemaObject {
  return { type: 'object', properties: { id: ID_SCHEMA }, required: ['id'] }
}

function schemaFor(m: ModelDefinition, operation: Operation): JsonSchemaObject {
  switch (operation) {
    case 'findAll':
      return findAllSchema(m)
    case 'find':
      return findSchema(m)
    case 'create':
      return bodySchema(m, 'create')
    case 'update':
      return updateSchema(m)
    case 'delete':
      return deleteSchema()
  }
}

function describe(m: ModelDefinition, operation: Operation): string {
  const noun = m.name
  switch (operation) {
    case 'findAll':
      return `List ${noun} records from Confetti.${sampleFor(m)}`
    case 'find':
      return `Fetch a single ${noun} from Confetti by id.${sampleFor(m)}`
    case 'create':
      return `Create a new ${noun} in Confetti.`
    case 'update':
      return `Update an existing ${noun} in Confetti by id. Only the fields you pass are changed.`
    case 'delete':
      return `Permanently delete a ${noun} from Confetti by id. This cannot be undone.`
  }
}

function annotate(m: ModelDefinition, operation: Operation, name: string): ToolAnnotations {
  const readOnly = operation === 'find' || operation === 'findAll'
  return {
    title: name,
    readOnlyHint: readOnly,
    ...(operation === 'delete' ? { destructiveHint: true } : {}),
    ...(operation === 'update' || operation === 'delete' ? { idempotentHint: true } : {}),
    ...(operation === 'create' ? { destructiveHint: false } : {}),
  }
}

export function buildTools(): GeneratedTool[] {
  return listResourceOperations().map(({ modelKey, resourceName, operation }) => {
    const m = model(modelKey)
    const name = toolName(resourceName, operation)
    return {
      modelKey,
      operation,
      definition: {
        name,
        description: describe(m, operation),
        inputSchema: schemaFor(m, operation),
        annotations: annotate(m, operation, name),
      },
    }
  })
}
