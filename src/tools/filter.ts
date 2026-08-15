import { RESOURCE_MAP, type ModelKey, type Operation } from '../confetti/resource-map.js'
import { camelToSnake } from './names.js'
import type { GeneratedTool } from './definitions.js'

export class ToolFilterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolFilterError'
  }
}

/** Domain verbs plus their HTTP-verb aliases. `read` covers find and find_all. */
const OP_ALIASES: Record<string, Operation[]> = {
  read: ['find', 'findAll'],
  get: ['find', 'findAll'],
  create: ['create'],
  post: ['create'],
  update: ['update'],
  put: ['update'],
  patch: ['update'],
  delete: ['delete'],
}

const RESOURCE_LOOKUP: Record<string, ModelKey> = Object.fromEntries(
  (Object.keys(RESOURCE_MAP) as ModelKey[]).flatMap((modelKey) => {
    const resourceName = RESOURCE_MAP[modelKey]
    return [
      [resourceName.toLowerCase(), modelKey],
      [camelToSnake(resourceName), modelKey],
    ]
  }),
)

export interface ToolFilter {
  operations?: Set<Operation>
  resources?: Set<ModelKey>
}

function splitList(value: unknown): string[] | undefined {
  if (typeof value !== 'string') return undefined
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  return parts.length > 0 ? parts : undefined
}

export function parseToolFilter(query: Record<string, unknown>): ToolFilter {
  const filter: ToolFilter = {}

  const ops = splitList(query['ops'])
  if (ops) {
    const operations = new Set<Operation>()
    for (const op of ops) {
      const mapped = OP_ALIASES[op.toLowerCase()]
      if (!mapped) {
        throw new ToolFilterError(
          `Unknown op "${op}". Valid ops: ${Object.keys(OP_ALIASES).sort().join(', ')}.`,
        )
      }
      for (const operation of mapped) operations.add(operation)
    }
    filter.operations = operations
  }

  const resources = splitList(query['resources'])
  if (resources) {
    const selected = new Set<ModelKey>()
    for (const resource of resources) {
      const modelKey = RESOURCE_LOOKUP[resource.toLowerCase()]
      if (!modelKey) {
        throw new ToolFilterError(
          `Unknown resource "${resource}". Valid resources: ${Object.values(RESOURCE_MAP).sort().join(', ')}.`,
        )
      }
      selected.add(modelKey)
    }
    filter.resources = selected
  }

  return filter
}

export function selectTools(all: GeneratedTool[], filter: ToolFilter): GeneratedTool[] {
  return all.filter((tool) => {
    if (filter.operations && !filter.operations.has(tool.operation)) return false
    if (filter.resources && !filter.resources.has(tool.modelKey)) return false
    return true
  })
}

export function toolSetCacheKey(query: Record<string, unknown>): string {
  const normalise = (value: unknown) => (splitList(value) ?? []).map((v) => v.toLowerCase()).sort().join(',')
  return `ops=${normalise(query['ops'])}|resources=${normalise(query['resources'])}`
}
