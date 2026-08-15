export interface Config {
  port: number
  apiHost: string
  apiProtocol: string
  logLevel: string
}

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 8080
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT "${raw}": expected an integer between 1 and 65535.`)
  }
  return port
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    port: readPort(env['PORT']),
    apiHost: env['CONFETTI_API_HOST'] ?? 'api.confetti.events',
    apiProtocol: env['CONFETTI_API_PROTOCOL'] ?? 'https',
    logLevel: env['LOG_LEVEL'] ?? 'info',
  }
}
