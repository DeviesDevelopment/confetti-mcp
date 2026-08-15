export interface ApiKeyCarrier {
  headers: Record<string, unknown>
  params?: Record<string, string>
}

function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Extracts the caller's Confetti API key.
 *
 * Precedence: Authorization: Bearer, then X-Api-Key, then the :apiKey path
 * segment. The path form exists only for clients that cannot set headers and
 * is documented as discouraged.
 */
export function extractApiKey(req: ApiKeyCarrier): string | undefined {
  const authorization = clean(firstString(req.headers['authorization']))
  if (authorization) {
    const match = /^Bearer[ ]+(.+)$/i.exec(authorization)
    const token = clean(match?.[1])
    if (token) return token
    return undefined
  }

  const alias = clean(firstString(req.headers['x-api-key']))
  if (alias) return alias

  return clean(req.params?.['apiKey'])
}
