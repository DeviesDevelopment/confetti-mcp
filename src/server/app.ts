import express from 'express'
import type { Config } from '../config.js'

export const SERVER_NAME = 'confetti-mcp'
export const SERVER_VERSION = '0.1.0'

export function createApp(_config: Config): express.Express {
  const app = express()
  app.use(express.json({ limit: '4mb' }))

  app.get('/', (_req, res) => {
    res.json({
      status: 'ok',
      server: SERVER_NAME,
      version: SERVER_VERSION,
      usage: 'POST /mcp with an "Authorization: Bearer <confetti-api-key>" header.',
    })
  })

  return app
}
