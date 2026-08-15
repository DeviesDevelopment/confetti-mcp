/**
 * `confetti-node` does not export its error classes — src/errors.ts is absent
 * from the package entry point and `exports` only exposes ".". Every error it
 * throws does set `name`, so classification goes by that instead of instanceof.
 */

/** Redacts anything shaped like a Confetti API key before it reaches a client. */
function redact(text: string): string {
  return text.replace(/\bsk_[A-Za-z0-9_-]{4,}/g, '[redacted]')
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

export function toolErrorMessage(error: unknown, toolName: string): string {
  const detail = redact(messageOf(error))
  switch (nameOf(error)) {
    case 'ParameterError':
    case 'ZodError':
      return `Invalid parameters for '${toolName}': ${detail}`
    case 'NotFoundError':
      return `Not found in '${toolName}': ${detail}`
    case 'OperationNotFoundError':
      return `Unsupported operation '${toolName}': ${detail}`
    default:
      return `Error in '${toolName}': [${nameOf(error)}] ${detail}`
  }
}
