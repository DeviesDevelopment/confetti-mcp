import { resourceFor, type Operation } from '../confetti/resource-map.js'
import type { GeneratedTool } from './definitions.js'
import { parameterError, validateArgs } from './validate.js'
import { shapeDeleted, shapeList, shapeOk, shapeRecord, type PageInfo } from './shape.js'

export const DEFAULT_PAGE_SIZE = 25

/**
 * Upper bound on a caller-supplied page size. `pageOptionsSchema` upstream has
 * no `.max()`, so without this one `findAll` with `page.size: 1000000` buffers,
 * denormalises and re-serialises an unbounded response on a shared process.
 * The public API tops out well below this, so a legitimate call never notices.
 */
export const MAX_PAGE_SIZE = 100

/**
 * Wall-clock ceiling on a single upstream call. `confetti` looks guarded —
 * its adapter passes `timeout: 5000/15000` to node-fetch — but node-fetch v3
 * removed that option and reads only `signal`, so nothing bounds the call
 * today. Without a deadline a slow or blackholed api.confetti.events turns
 * every in-flight tools/call into a leak: client connection, Server/transport
 * pair and upstream socket held until TCP gives up.
 */
export const DEFAULT_TIMEOUT_MS = 25_000

export interface CallContext {
  apiKey: string
  apiHost?: string
  apiProtocol?: string
  /** Overrides DEFAULT_TIMEOUT_MS for this connection. */
  timeoutMs?: number
}

type AnyArgs = Record<string, unknown>

function baseOptions(context: CallContext): AnyArgs {
  return {
    apiKey: context.apiKey,
    ...(context.apiHost ? { apiHost: context.apiHost } : {}),
    ...(context.apiProtocol ? { apiProtocol: context.apiProtocol } : {}),
    // Always raw: the adapter's deserialiser is a process-global yayson Store
    // that leaks records between calls (and so between tenants). shape.ts
    // flattens the JSON:API body with a Store of its own instead.
    raw: true,
  }
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

function clamped(value: unknown): unknown {
  return typeof value === 'number' && value > MAX_PAGE_SIZE ? MAX_PAGE_SIZE : value
}

/**
 * A non-object `page` used to be swallowed and replaced with the default, so
 * `page: 2` quietly returned page 1 — the model then loops over the same
 * records or concludes they do not exist. It is now an error naming the shape,
 * and caller-supplied sizes are clamped so one call cannot amplify into an
 * unbounded response on a shared process.
 */
function pageOption(page: unknown): AnyArgs {
  if (page === undefined) return { size: DEFAULT_PAGE_SIZE }
  if (typeof page !== 'object' || page === null || Array.isArray(page)) {
    throw parameterError(
      `page must be an object such as {"number": 2, "size": ${DEFAULT_PAGE_SIZE}} — got ${JSON.stringify(page) ?? typeof page}. Use page.number for the page you want.`,
    )
  }
  const provided = { ...(page as AnyArgs) }
  if ('size' in provided) provided['size'] = clamped(provided['size'])
  if ('limit' in provided) provided['limit'] = clamped(provided['limit'])
  return { size: DEFAULT_PAGE_SIZE, ...provided }
}

/** What the caller actually asked for, echoed back in the read envelope. */
function pageInfo(page: AnyArgs): PageInfo {
  const number = typeof page['number'] === 'number' ? page['number'] : 1
  const size = typeof page['size'] === 'number' ? page['size'] : page['limit']
  return { number, size: typeof size === 'number' ? size : DEFAULT_PAGE_SIZE }
}

function withoutId(args: AnyArgs): AnyArgs {
  const { id, ...rest } = args
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

/**
 * Collapses an array filter value to the comma list the API actually accepts.
 *
 * `confetti` serialises options with `qs.stringify` and no `arrayFormat`, so an
 * array filter goes out as `filter[status][0]=attending`. Verified against the
 * live API: that form returns **HTTP 500** on `/tickets`, while
 * `filter[status]=attending` succeeds and `filter[status]=waitlist,attending`
 * genuinely ORs the two (25 records, where `waitlist` alone returns 0 — so it
 * is a union, not first-value-only).
 *
 * The tool schemas keep advertising an array, which is the right shape for a
 * caller to reason about; only the wire representation changes. Confetti's
 * filter enums contain no commas, so joining is lossless.
 */
function commaJoinFilters(filter: unknown): unknown {
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) return filter
  const out: AnyArgs = {}
  for (const [key, value] of Object.entries(filter as AnyArgs)) {
    out[key] = Array.isArray(value) ? value.join(',') : value
  }
  return out
}

export function callerOptions(operation: Operation, args: AnyArgs): AnyArgs {
  const options: AnyArgs = {}
  for (const key of CALLER_OPTION_KEYS[operation]) {
    const value = args[key]
    if (value === undefined) continue
    options[key] = key === 'filter' ? commaJoinFilters(value) : value
  }
  return options
}

/**
 * Races the upstream call against a real deadline. The rejection carries the
 * ParameterError name so it reaches the caller as an actionable message rather
 * than an opaque server fault, plus `code`/`timeoutMs` so error formatting can
 * recognise a timeout without string-matching. Nothing here can cancel the
 * in-flight socket — `confetti` accepts no AbortSignal — so this frees the MCP
 * request and transport, and the upstream fix is still worth filing.
 */
async function withDeadline<T>(work: Promise<T>, timeoutMs: number, toolName: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        parameterError(
          `'${toolName}' gave up waiting for the Confetti API after ${timeoutMs} ms. Retry once; if it repeats, ask for fewer records (a smaller page.size) or fewer include values.`,
          { code: 'UPSTREAM_TIMEOUT', timeoutMs },
        ),
      )
    }, timeoutMs)
    // The process must not be kept alive by a pending deadline.
    timer.unref?.()
  })

  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

export async function callTool(
  tool: GeneratedTool,
  args: AnyArgs,
  context: CallContext,
): Promise<unknown> {
  return withDeadline(
    dispatch(tool, args, context),
    context.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    tool.definition.name,
  )
}

async function dispatch(
  tool: GeneratedTool,
  args: AnyArgs,
  context: CallContext,
): Promise<unknown> {
  // Fail closed on the advertised contract before anything leaves the process.
  validateArgs(tool, args)

  const resource = resourceFor(tool.modelKey) as unknown as Record<
    string,
    (...callArgs: unknown[]) => Promise<unknown>
  >
  const options = baseOptions(context)

  switch (tool.operation) {
    case 'findAll': {
      const caller = callerOptions('findAll', args)
      const page = pageOption(args['page'])
      caller['page'] = page
      const body = await resource['findAll']!({ ...caller, ...options })
      return shapeList(body, pageInfo(page))
    }
    case 'find': {
      const id = requireId(args)
      const body = await resource['find']!(id, { ...callerOptions('find', args), ...options })
      return shapeRecord(body) ?? shapeOk('find', tool.modelKey, id)
    }
    case 'create': {
      const body = await resource['create']!(stripReserved(args), options)
      return shapeRecord(body) ?? shapeOk('create', tool.modelKey)
    }
    case 'update': {
      const id = requireId(args)
      const body = await resource['update']!(id, stripReserved(withoutId(args)), options)
      return shapeRecord(body) ?? shapeOk('update', tool.modelKey, id)
    }
    case 'delete': {
      const id = requireId(args)
      await resource['delete']!(id, options)
      return shapeDeleted(tool.modelKey, id)
    }
  }
}
