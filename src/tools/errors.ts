/**
 * `confetti-node` does not export its error classes — src/errors.ts is absent
 * from the package entry point and `exports` only exposes ".". Every error it
 * throws does set `name`, so classification goes by that instead of instanceof.
 *
 * Everything in this file exists to answer one question for the model: what do
 * I do next? A rejection the model cannot act on costs a retry loop, and the
 * three worst offenders were all information this process already had and threw
 * away — the JSON:API body hanging off the thrown error, the structured `issues`
 * array behind a pretty-printed blob, and a bare `HTTP nnn` with no class
 * guidance. Every path still ends in `redact()`.
 */

/**
 * Redacts the caller's key, plus anything shaped like one, before it reaches a
 * client. Confetti enforces no key format (`apiKey: z.string()`), so the shape
 * pattern is only a secondary net — exact-matching the caller's own key is what
 * actually holds the "key never reaches a client" constraint.
 */
function redact(text: string, secret?: string): string {
  const byShape = text.replace(/\bsk_[A-Za-z0-9_-]{4,}/g, '[redacted]')
  // Guard the length: replaceAll('') inserts between every character.
  if (!secret || secret.length < 4) return byShape
  return byShape.replaceAll(secret, '[redacted]')
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function property(error: unknown, key: string): unknown {
  return isRecord(error) ? error[key] : undefined
}

/* ------------------------------------------------------------------ *
 * The body the adapter attaches and nobody read
 * ------------------------------------------------------------------ */

/**
 * `ParameterError`/`NotFoundError` are constructed with the parsed JSON:API
 * error body `Object.assign`ed onto them, and for a JSON body the *message* is
 * the literal string "validation" — so the entire actionable detail sits one
 * property away from a caller that only reads `.message`. Harvest the own
 * properties that are not error plumbing.
 *
 * `errorType` is confetti's verbatim copy of the message and is skipped: it
 * would say the same word twice.
 */
const PLUMBING_KEYS = new Set(['name', 'message', 'stack', 'errorType', 'code', 'timeoutMs'])

/** A long body helps nobody; the first lines carry the actionable part. */
const MAX_BODY_CHARS = 800

function attachedBody(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined

  const harvested: Record<string, unknown> = {}
  for (const key of Object.getOwnPropertyNames(error)) {
    if (PLUMBING_KEYS.has(key)) continue
    const value = (error as unknown as Record<string, unknown>)[key]
    if (value === undefined || typeof value === 'function') continue
    harvested[key] = value
  }
  if (Object.keys(harvested).length === 0) return undefined

  let json: string
  try {
    json = JSON.stringify(harvested)
  } catch {
    // A body that will not serialise (a cycle, a BigInt) is not worth failing
    // the whole error path for.
    return undefined
  }
  if (json === undefined) return undefined
  const bounded = json.length > MAX_BODY_CHARS ? `${json.slice(0, MAX_BODY_CHARS)}…` : json
  return `Confetti replied: ${bounded}`
}

/* ------------------------------------------------------------------ *
 * Zod issues, duck-typed
 * ------------------------------------------------------------------ */

/**
 * zod is a transitive dependency of `confetti` only — importing it here would
 * add a second copy that is not the one that threw, and a major bump would then
 * break the mapping silently. The `issues` array has been stable across zod 3
 * and 4, so it is read structurally instead.
 */
interface DuckIssue {
  path?: unknown
  message?: unknown
  code?: unknown
  expected?: unknown
  errors?: unknown
  unionErrors?: unknown
}

const MAX_ISSUE_LINES = 10

function issuesOf(error: unknown): DuckIssue[] | undefined {
  const issues = property(error, 'issues')
  if (!Array.isArray(issues) || issues.length === 0) return undefined
  return issues.filter(isRecord) as DuckIssue[]
}

function pathOf(issue: DuckIssue): string {
  const path = issue.path
  if (!Array.isArray(path) || path.length === 0) return '(root)'
  return path
    .map((segment) => (typeof segment === 'number' ? `[${segment}]` : String(segment)))
    .join('.')
    .replaceAll('.[', '[')
}

/** The nested issues of a union, in either zod 4 (`errors`) or 3 (`unionErrors`) shape. */
function unionBranches(issue: DuckIssue): DuckIssue[] {
  const nested: DuckIssue[] = []
  if (Array.isArray(issue.errors)) {
    for (const group of issue.errors) {
      if (Array.isArray(group)) nested.push(...group.filter(isRecord))
      else if (isRecord(group)) nested.push(group)
    }
  }
  if (Array.isArray(issue.unionErrors)) {
    for (const nestedError of issue.unionErrors) {
      const inner = issuesOf(nestedError)
      if (inner) nested.push(...inner)
    }
  }
  return nested
}

/**
 * A union failure reports "Invalid input" at the top level and hides what it
 * would have accepted in its branches — the shape every date field takes.
 */
function unionMessage(issue: DuckIssue): string {
  const accepted = [
    ...new Set(
      unionBranches(issue)
        .map((branch) => (typeof branch.expected === 'string' ? branch.expected : undefined))
        .filter((expected): expected is string => expected !== undefined),
    ),
  ]
  if (accepted.length === 0) return 'value matched none of the accepted forms'
  return `expected ${accepted.join(' or ')}`
}

function issueMessage(issue: DuckIssue): string {
  if (issue.code === 'invalid_union') return unionMessage(issue)
  const message = typeof issue.message === 'string' ? issue.message : String(issue.code ?? 'invalid')
  // The two zod phrasings a model most often misreads as a type problem when it
  // is really a missing or unparsed value.
  if (/received undefined/i.test(message)) return 'required field is missing'
  if (/received NaN/i.test(message)) return 'expected a number, got a non-numeric value'
  return message
}

function formatIssues(issues: DuckIssue[]): string {
  const shown = issues.slice(0, MAX_ISSUE_LINES)
  const lines = shown.map((issue) => `- ${pathOf(issue)}: ${issueMessage(issue)}`)
  if (issues.length > shown.length) lines.push(`- …and ${issues.length - shown.length} more`)
  return `\n${lines.join('\n')}`
}

/* ------------------------------------------------------------------ *
 * Bare HTTP statuses
 * ------------------------------------------------------------------ */

/**
 * Anything the adapter does not turn into a typed error arrives as an `Error`
 * whose whole message is `HTTP 500` — no body, no headers, nothing to act on.
 * The 500 line is the important one: live-verified with curl,
 * api.confetti.events answers **500, not 401, for an invalid API key**, so a
 * model with no guidance reads an outage and retries forever.
 */
function httpGuidance(message: string): string | undefined {
  const status = Number(/^HTTP (\d{3})$/.exec(message.trim())?.[1])
  if (!Number.isInteger(status)) return undefined

  if (status === 401 || status === 403) {
    return 'The Confetti API rejected this connection\'s API key, or the key has no access to this resource. Do not retry — the key has to be corrected by the user.'
  }
  if (status === 429) {
    return 'Rate limited. Wait before retrying, and ask for fewer records per call.'
  }
  if (status === 404) {
    return 'No such record, or the key cannot see it. Do not retry the same id.'
  }
  if (status === 500) {
    return 'The Confetti API returns 500 for an invalid API key as well as for its own faults: if every call on this connection fails this way, the key is most likely wrong or revoked and the user has to fix it. Otherwise it may be transient — retry once, do not loop.'
  }
  if (status === 502 || status === 503 || status === 504) {
    return 'The Confetti API is temporarily unavailable (transient). Retry once, then report the outage rather than looping.'
  }
  if (status >= 400 && status < 500) {
    return 'Confetti rejected the request itself; re-read the tool schema before trying again.'
  }
  return 'An unexpected Confetti API fault. Retry once, do not loop.'
}

/* ------------------------------------------------------------------ *
 * Network and deadline failures
 * ------------------------------------------------------------------ */

/**
 * The deadline in dispatch names its rejection `ParameterError` so it reaches
 * the caller as an actionable tool error rather than an opaque server fault;
 * `code` is what identifies it. The message already carries the real
 * `timeoutMs` — the package's own 5s/15s numbers are dead under node-fetch v3
 * and must never be quoted at a model.
 */
function isUpstreamTimeout(error: unknown): boolean {
  return property(error, 'code') === 'UPSTREAM_TIMEOUT'
}

function networkGuidance(name: string, message: string): boolean {
  // A bare `TypeError` is far more often a bug in this process than a socket
  // failure, so it only counts as network when it says so.
  const byName = name === 'FetchError' || name === 'AbortError'
  const byMessage = /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(message)
  return byName || byMessage
}

const NETWORK_GUIDANCE =
  'The Confetti API could not be reached (network-level failure). Retry once; if it repeats, the API or this server\'s outbound network is down.'

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

function detailOf(error: unknown, name: string): string {
  const issues = issuesOf(error)
  // The `issues` array *is* the message for a ZodError — `.message` is the same
  // data pretty-printed over ~60 lines, so it is replaced, not appended.
  if (issues) return formatIssues(issues)

  const message = messageOf(error)
  const parts = [
    message,
    httpGuidance(message),
    networkGuidance(name, message) ? NETWORK_GUIDANCE : undefined,
    attachedBody(error),
  ]
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ')
}

export function toolErrorMessage(error: unknown, toolName: string, secret?: string): string {
  const name = nameOf(error)

  if (isUpstreamTimeout(error)) {
    return redact(`Timed out in '${toolName}': ${messageOf(error)}`, secret)
  }

  const detail = detailOf(error, name)

  let message: string
  switch (name) {
    case 'ParameterError':
    case 'ZodError':
      message = `Invalid parameters for '${toolName}': ${detail}`
      break
    case 'NotFoundError':
      message = `Not found in '${toolName}': ${detail}`
      break
    case 'OperationNotFoundError':
      message = `Unsupported operation '${toolName}': ${detail}`
      break
    default:
      message = `Error in '${toolName}': [${name}] ${detail}`
  }

  return redact(message, secret)
}
