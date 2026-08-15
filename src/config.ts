export interface Config {
  port: number
  apiHost: string
  apiProtocol: string
  logLevel: string
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return {
    port: Number(env['PORT'] ?? 8080),
    apiHost: env['CONFETTI_API_HOST'] ?? 'api.confetti.events',
    apiProtocol: env['CONFETTI_API_PROTOCOL'] ?? 'https',
    logLevel: env['LOG_LEVEL'] ?? 'info',
  }
}
