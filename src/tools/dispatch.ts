import { resourceFor } from '../confetti/resource-map.js'
import type { GeneratedTool } from './definitions.js'

export const DEFAULT_PAGE_SIZE = 25

export interface CallContext {
  apiKey: string
  apiHost?: string
  apiProtocol?: string
}

type AnyArgs = Record<string, unknown>

function baseOptions(context: CallContext): AnyArgs {
  return {
    apiKey: context.apiKey,
    ...(context.apiHost ? { apiHost: context.apiHost } : {}),
    ...(context.apiProtocol ? { apiProtocol: context.apiProtocol } : {}),
  }
}

function requireId(args: AnyArgs): string | number {
  const id = args['id']
  if (typeof id === 'string' || typeof id === 'number') return id
  throw Object.assign(new Error('id is required'), { name: 'ParameterError' })
}

function withDefaultPage(page: unknown): AnyArgs {
  const provided = typeof page === 'object' && page !== null ? (page as AnyArgs) : {}
  return { size: DEFAULT_PAGE_SIZE, ...provided }
}

function withoutId(args: AnyArgs): AnyArgs {
  const rest = { ...args }
  delete rest['id']
  return rest
}

export async function callTool(
  tool: GeneratedTool,
  args: AnyArgs,
  context: CallContext,
): Promise<unknown> {
  const resource = resourceFor(tool.modelKey) as unknown as Record<
    string,
    (...callArgs: unknown[]) => Promise<unknown>
  >
  const options = baseOptions(context)

  switch (tool.operation) {
    case 'findAll': {
      const { page, ...rest } = args
      return resource['findAll']!({ ...rest, page: withDefaultPage(page), ...options })
    }
    case 'find': {
      const id = requireId(args)
      return resource['find']!(id, { ...withoutId(args), ...options })
    }
    case 'create': {
      return resource['create']!(args, options)
    }
    case 'update': {
      const id = requireId(args)
      return resource['update']!(id, withoutId(args), options)
    }
    case 'delete': {
      const id = requireId(args)
      return resource['delete']!(id, options)
    }
  }
}
