import express from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Config } from '../config.js'
import { extractApiKey } from './auth.js'
import { createMcpServer, getToolSet, SERVER_NAME, SERVER_VERSION } from './mcp.js'
import { ToolFilterError } from '../tools/filter.js'

export { SERVER_NAME, SERVER_VERSION }

function methodNotAllowed(_req: express.Request, res: express.Response): void {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'This server is stateless; use POST /mcp.' },
    id: null,
  })
}

export function createApp(config: Config): express.Express {
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

  const handleMcp: express.RequestHandler = async (req, res) => {
    const apiKey = extractApiKey({
      headers: req.headers as Record<string, unknown>,
      params: req.params as unknown as Record<string, string>,
      query: req.query as Record<string, unknown>,
    })
    if (!apiKey) {
      res.status(401).set('WWW-Authenticate', 'Bearer').json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Missing Confetti API key. Send "Authorization: Bearer <key>".' },
        id: null,
      })
      return
    }

    let tools
    try {
      tools = getToolSet(req.query as Record<string, unknown>)
    } catch (error) {
      if (error instanceof ToolFilterError) {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32602, message: error.message }, id: null })
        return
      }
      throw error
    }

    const server = createMcpServer({
      tools,
      context: { apiKey, apiHost: config.apiHost, apiProtocol: config.apiProtocol },
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

    res.on('close', () => {
      void transport.close()
      void server.close()
    })

    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  }

  app.post('/mcp', handleMcp)
  app.get('/mcp', methodNotAllowed)
  app.delete('/mcp', methodNotAllowed)

  // Fallback for MCP clients that cannot set request headers (notably the
  // claude.ai web connector UI). The key travels in the URL; the server
  // performs no request logging at all, so nothing here ever gets logged.
  app.post('/mcp/k/:apiKey', handleMcp)
  app.get('/mcp/k/:apiKey', methodNotAllowed)
  app.delete('/mcp/k/:apiKey', methodNotAllowed)

  // Never echo the request URL: the /mcp/k/<key> carrier puts the caller's API
  // key in the path, and Express's default 404 and error handlers would render
  // it verbatim into the response body.
  app.use((_req, res) => {
    res.status(404).json({ jsonrpc: '2.0', error: { code: -32601, message: 'Not found. Use POST /mcp.' }, id: null })
  })

  app.use(((error, _req, res, _next) => {
    console.error(JSON.stringify({ level: 'error', msg: 'unhandled', name: error instanceof Error ? error.name : typeof error }))
    res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error.' }, id: null })
  }) as express.ErrorRequestHandler)

  return app
}
