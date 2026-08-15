export interface ApiKeyCarrier {
  headers: Record<string, unknown>
  params?: Record<string, string>
  query?: Record<string, unknown>
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
 * Precedence: Authorization: Bearer, then X-Api-Key, then the ?apiKey query
 * parameter, then the :apiKey path segment. The query and path forms exist
 * only for clients that cannot set headers and are documented as discouraged.
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

  const queryKey = clean(firstString(req.query?.['apiKey']))
  if (queryKey) return queryKey

  return clean(req.params?.['apiKey'])
}
