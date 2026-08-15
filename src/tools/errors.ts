/**
 * `confetti-node` does not export its error classes — src/errors.ts is absent
 * from the package entry point and `exports` only exposes ".". Every error it
 * throws does set `name`, so classification goes by that instead of instanceof.
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

export function toolErrorMessage(error: unknown, toolName: string, secret?: string): string {
  const detail = messageOf(error)
  const name = nameOf(error)

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
