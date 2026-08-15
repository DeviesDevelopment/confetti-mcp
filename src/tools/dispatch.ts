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

function parameterError(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { name: 'ParameterError' }, extra)
}

/**
 * Ids are interpolated raw into the upstream URL path (`${model.path}/${id}`)
 * and node-fetch's WHATWG URL parsing then collapses dot segments. An id of
 * `../payments/7` on confetti_events_find issues `GET /payments/7` — with the
 * caller's real key attached — which defeats the enforced ?resources= filter
 * on every id-bearing tool, delete included. Allowlisting the characters
 * Confetti actually uses (numeric ids and hashids) closes that by construction;
 * a denylist of `/ \ ? #` would still let percent-encodings and unicode
 * separators through.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]+$/

function requireId(args: AnyArgs): string {
  const id = args['id']
  if (typeof id !== 'string' && typeof id !== 'number') {
    throw parameterError('id is required')
  }
  const asString = String(id)
  if (!ID_PATTERN.test(asString)) {
    throw parameterError(
      `id must be a single record identifier made of letters, digits, "-" or "_" — got ${JSON.stringify(asString)}. Path segments, empty values and query characters are not allowed.`,
    )
  }
  return asString
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

/**
 * Keys that control the upstream connection itself. They are never accepted
 * from tool arguments: `findAll` and `find` merge caller args and connection
 * options into one object, so without this a caller could set apiHost and
 * redirect the request — with the real API key attached — to a host of their
 * choosing. Spread order alone is not enough, because CallContext permits
 * apiHost/apiProtocol to be absent.
 */
const RESERVED_OPTION_KEYS = ['apiKey', 'apiHost', 'apiProtocol', 'raw'] as const

function stripReserved(args: AnyArgs): AnyArgs {
  const clean = { ...args }
  for (const key of RESERVED_OPTION_KEYS) delete clean[key]
  return clean
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
      const { page, ...rest } = stripReserved(args)
      return resource['findAll']!({ ...rest, page: withDefaultPage(page), ...options })
    }
    case 'find': {
      const id = requireId(args)
      return resource['find']!(id, { ...stripReserved(withoutId(args)), ...options })
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
