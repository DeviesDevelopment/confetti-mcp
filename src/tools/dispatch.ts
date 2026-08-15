import { resourceFor, type Operation } from '../confetti/resource-map.js'
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
 * Keys that control the upstream connection itself (`confetti`'s
 * `baseOptionsSchema`). They are never taken from tool arguments, and they are
 * also stripped out of create/update bodies so a caller cannot smuggle one
 * through the body either. No generated schema advertises a field by any of
 * these names, so stripping them can never drop a real field.
 */
const RESERVED_OPTION_KEYS = ['apiKey', 'apiHost', 'apiProtocol', 'raw'] as const

function stripReserved(args: AnyArgs): AnyArgs {
  const clean = { ...args }
  for (const key of RESERVED_OPTION_KEYS) delete clean[key]
  return clean
}

/**
 * The ONLY option keys a caller may contribute, per operation — exactly what
 * the generated schemas advertise. This is deliberately an allowlist: the
 * previous denylist mirrored `confetti`'s connection options by hand, so the
 * first new key upstream added (`basePath`, `apiVersion`, …) would become
 * settable from prompt-injectable tool arguments with no compile error and no
 * failing test. An allowlist makes every future upstream option inert by
 * construction.
 */
export const CALLER_OPTION_KEYS = {
  findAll: ['filter', 'sort', 'include', 'page'],
  find: ['include'],
  create: [],
  update: [],
  delete: [],
} as const satisfies Record<Operation, readonly string[]>

export function callerOptions(operation: Operation, args: AnyArgs): AnyArgs {
  const options: AnyArgs = {}
  for (const key of CALLER_OPTION_KEYS[operation]) {
    const value = args[key]
    if (value !== undefined) options[key] = value
  }
  return options
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
      const caller = callerOptions('findAll', args)
      caller['page'] = withDefaultPage(args['page'])
      return resource['findAll']!({ ...caller, ...options })
    }
    case 'find': {
      const id = requireId(args)
      return resource['find']!(id, { ...callerOptions('find', args), ...options })
    }
    case 'create': {
      return resource['create']!(stripReserved(args), options)
    }
    case 'update': {
      const id = requireId(args)
      return resource['update']!(id, stripReserved(withoutId(args)), options)
    }
    case 'delete': {
      const id = requireId(args)
      return resource['delete']!(id, options)
    }
  }
}
