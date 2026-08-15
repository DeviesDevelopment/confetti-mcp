import type { GeneratedTool, JsonSchemaObject } from './definitions.js'

/**
 * Pre-dispatch validation, driven entirely by the tool's own generated
 * `inputSchema`. There is deliberately no per-tool knowledge in this file: the
 * upstream registry is the only source of truth, so new resources and fields
 * are validated the moment they appear.
 *
 * It exists because upstream Zod *strips* unknown keys instead of rejecting
 * them: an update tool called with `{id: 5, titel: 'X'}` parsed to `{}`, sent
 * an empty PUT and returned success — a silent no-op the model could never
 * detect. Everything here fails closed, before any request goes out, with a
 * message naming the valid values so a model can correct itself in one turn.
 */

type Args = Record<string, unknown>

export function parameterError(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { name: 'ParameterError' }, extra)
}

/**
 * Keys that name the upstream connection. They are stripped by the dispatch
 * allowlist and can never influence the request, so they are ignored here
 * rather than rejected: the reserved-key regression tests pin that such a call
 * still completes against the real host with the trusted key.
 */
const CONNECTION_KEYS = new Set(['apiKey', 'apiHost', 'apiProtocol', 'raw'])

/** Plain data objects only — arrays and null are values, not schema objects. */
function isRecord(value: unknown): value is Args {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function propertiesOf(node: Args): Args | undefined {
  const properties = node['properties']
  if (!isRecord(properties) || Object.keys(properties).length === 0) return undefined
  // A schema that also accepts arbitrary extra keys (`looseObject` upstream,
  // e.g. block.content and ticket.values) is free-form: never recurse into it.
  const additional = node['additionalProperties']
  if (additional !== undefined && additional !== false) return undefined
  return properties
}

function enumOf(node: Args): string[] | undefined {
  const values = node['enum']
  if (!Array.isArray(values)) return undefined
  return values.every((value) => typeof value === 'string' || typeof value === 'number')
    ? values.map(String)
    : undefined
}

/** Branches of an anyOf, plus the node itself, so unions are inspectable. */
function branches(node: Args): Args[] {
  const anyOf = node['anyOf']
  if (!Array.isArray(anyOf)) return [node]
  return [node, ...anyOf.filter(isRecord)]
}

function isDateTime(node: Args): boolean {
  return branches(node).some((branch) => branch['format'] === 'date-time')
}

/**
 * ISO 8601 date or date-time. Plain dates are accepted deliberately — the API
 * takes them — so local validation never rejects input the API would honour.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$/

function distance(a: string, b: string): number {
  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_value, index) => index)]
  for (let i = 1; i <= a.length; i += 1) {
    const row: number[] = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      row.push(Math.min(row[j - 1]! + 1, rows[i - 1]![j]! + 1, rows[i - 1]![j - 1]! + cost))
    }
    rows.push(row)
  }
  return rows[a.length]![b.length]!
}

function suggestion(unknownKey: string, candidates: string[]): string {
  const lower = unknownKey.toLowerCase()
  let best: { key: string; score: number } | undefined
  for (const candidate of candidates) {
    const score = distance(lower, candidate.toLowerCase())
    if (score <= Math.max(2, Math.floor(candidate.length / 3)) && (!best || score < best.score)) {
      best = { key: candidate, score }
    }
  }
  return best ? ` Did you mean "${best.key}"?` : ''
}

/** Long field lists are error-path only, but still worth keeping readable. */
function list(values: string[]): string {
  const shown = values.slice(0, 60)
  return shown.join(', ') + (values.length > shown.length ? ', …' : '')
}

function label(path: string[], key: string): string {
  return [...path, key].join('.')
}

function checkValue(node: Args, value: unknown, path: string[], toolName: string): void {
  if (value === undefined || value === null) return

  if (isDateTime(node) && typeof value === 'string' && !ISO_DATE.test(value.trim())) {
    throw parameterError(
      `${path.join('.')}: ${JSON.stringify(value)} is not a valid date for '${toolName}' — provide ISO 8601, e.g. "2026-09-01" or "2026-09-01T18:00:00Z".`,
    )
  }

  if (Array.isArray(value)) {
    const items = node['items']
    if (isRecord(items)) {
      for (const [index, entry] of value.entries()) {
        checkValue(items, entry, [...path.slice(0, -1), `${path.at(-1)}[${index}]`], toolName)
      }
    }
    // An `enum` sitting on the array itself (rather than on `items`) cannot be
    // satisfied by any array, so enforcing it here would reject every legal
    // value. Item-level enforcement above is correct under either spelling.
    return
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    for (const branch of branches(node)) {
      const allowed = enumOf(branch)
      // Only a branch that is itself scalar constrains a scalar value.
      if (allowed && branch['type'] !== 'array' && !allowed.includes(String(value))) {
        throw parameterError(
          `Invalid value ${JSON.stringify(value)} for ${path.join('.')} in '${toolName}'. Valid values: ${list(allowed)}.`,
        )
      }
    }
    return
  }

  if (isRecord(value)) {
    const properties = propertiesOf(node)
    if (properties) checkObject(properties, value, path, toolName)
  }
}

function checkObject(properties: Args, value: Args, path: string[], toolName: string): void {
  const valid = Object.keys(properties)
  for (const key of Object.keys(value)) {
    if (path.length === 0 && CONNECTION_KEYS.has(key)) continue
    if (!(key in properties)) {
      const where = path.length === 0 ? 'field' : `${path.join('.')} field`
      throw parameterError(
        `Unknown ${where} "${label(path, key)}" for '${toolName}'. Valid ${path.length === 0 ? 'fields' : 'keys'}: ${list(valid)}.${suggestion(key, valid)}`,
      )
    }
    const node = properties[key]
    if (isRecord(node)) checkValue(node, value[key], [...path, key], toolName)
  }
}

export function validateArgs(tool: GeneratedTool, args: Args): void {
  const schema: JsonSchemaObject = tool.definition.inputSchema
  const name = tool.definition.name

  if (!isRecord(args)) {
    throw parameterError(`'${name}' expects an object of arguments.`)
  }

  checkObject(schema.properties as Args, args, [], name)

  if (tool.operation === 'update') {
    const updatable = Object.keys(args).filter((key) => key !== 'id' && !CONNECTION_KEYS.has(key))
    if (updatable.length === 0) {
      const examples = Object.keys(schema.properties)
        .filter((key) => key !== 'id')
        .slice(0, 5)
      throw parameterError(
        `'${name}' was called with no updatable fields besides id — nothing would change. Pass at least one field, e.g. ${list(examples)}.`,
      )
    }
  }
}
