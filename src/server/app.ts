import express from 'express'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Config } from '../config.js'
import { extractApiKey } from './auth.js'
import { createMcpServer, getToolSet, logEvent, newRequestId, SERVER_NAME, SERVER_VERSION } from './mcp.js'
import { ToolFilterError } from '../tools/filter.js'

export { SERVER_NAME, SERVER_VERSION }

/** Mirrors the express.json limit; quoted to the caller, so keep them together. */
const BODY_LIMIT = '4mb'

/**
 * What express's own body parser already knows about a bad request, which the
 * final handler used to discard by hardcoding 500.
 *
 * A client typo reported as a server fault is retried forever by retry-on-5xx
 * logic, and every such retry lands in the error log as an "unhandled" entry,
 * masking the real 500s. These are the caller's fault, so they are answered as
 * 4xx and logged at warn.
 */
function clientFault(
  error: unknown,
): { status: number; code: number; message: string } | undefined {
  const type = (error as { type?: unknown } | null)?.type
  switch (type) {
    case 'entity.parse.failed':
      return { status: 400, code: -32700, message: 'Parse error: the request body is not valid JSON.' }
    case 'entity.too.large':
      return { status: 413, code: -32600, message: `Request body too large; the limit is ${BODY_LIMIT}.` }
    case 'encoding.unsupported':
      return { status: 415, code: -32600, message: 'Unsupported content encoding.' }
    case 'request.aborted':
      return { status: 400, code: -32600, message: 'Request aborted before the body was received.' }
    default:
      return undefined
  }
}

function methodNotAllowed(_req: express.Request, res: express.Response): void {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'This server is stateless; use POST /mcp.' },
    id: null,
  })
}

/**
 * Turns any error escaping a route into a JSON-RPC document.
 *
 * Exported so it can be tested directly: no HTTP request can reach the generic
 * 500 branch, because `extractApiKey` and `getToolSet` are total over their
 * inputs and every other fault is classified by `clientFault`. Reaching it
 * through the server would need module mocking behind an experimental Node
 * flag, which would print a warning on every test run forever to cover four
 * lines. A named export is the cheaper seam.
 */
export const errorHandler: express.ErrorRequestHandler = (error, _req, res, next) => {
  // A response already on the wire cannot be replaced with an error document;
  // express's default handler destroys the connection instead.
  if (res.headersSent) {
    next(error)
    return
  }

  const requestId = String(res.locals['requestId'] ?? newRequestId())
  const name = error instanceof Error ? error.name : typeof error
  const fault = clientFault(error)

  if (fault) {
    logEvent('warn', 'bad_request', { requestId, name, status: fault.status })
    res.status(fault.status).json({ jsonrpc: '2.0', error: { code: fault.code, message: fault.message }, id: null })
    return
  }

  // Never the message or the url: the /mcp/k/<key> carrier puts the caller's
  // key in the path, and an error message can quote the request body.
  logEvent('error', 'unhandled', { requestId, name, status: 500 })
  res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error.' }, id: null })
}

export function createApp(config: Config): express.Express {
  const app = express()

  // One id per request, so every line a request logs can be tied together.
  // Set before the body parser, which is itself a source of failures to log.
  app.use((_req, res, next) => {
    res.locals['requestId'] = newRequestId()
    next()
  })
  app.use(express.json({ limit: BODY_LIMIT }))

  app.get('/', (_req, res) => {
    res.json({
      status: 'ok',
      server: SERVER_NAME,
      version: SERVER_VERSION,
      usage: 'POST /mcp with an "Authorization: Bearer <confetti-api-key>" header.',
      // The one feature that shrinks the tool surface was invisible at exactly
      // the moment someone configures a connection.
      filtering:
        'All 63 tools are exposed by default. Narrow the connection with ?ops= and ?resources= on the connect URL, e.g. POST /mcp?ops=read&resources=events,tickets — the filter is enforced on tools/call, not just tools/list.',
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
      requestId: String(res.locals['requestId']),
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

  app.use(errorHandler)

  return app
}
