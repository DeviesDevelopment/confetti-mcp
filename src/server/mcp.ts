import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import { buildTools, type GeneratedTool } from '../tools/definitions.js'
import { parseToolFilter, selectTools, toolSetCacheKey } from '../tools/filter.js'
import { callTool, type CallContext } from '../tools/dispatch.js'
import { toolErrorMessage } from '../tools/errors.js'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json') as { version: string }

export const SERVER_NAME = 'confetti-mcp'
export const SERVER_VERSION = pkg.version

/** All 63 tools, generated once. Definition building walks every Zod schema. */
const ALL_TOOLS = buildTools()

/**
 * Every tool name that exists at all, regardless of filtering. Used only to
 * tell "this tool was filtered out of your connection" apart from "no such
 * tool", so a filtered caller gets an actionable message.
 */
const ALL_TOOL_NAMES = new Set(ALL_TOOLS.map((tool) => tool.definition.name))

/** Filtered tool sets are memoised per normalised query. */
const toolSetCache = new Map<string, GeneratedTool[]>()

const TOOL_SET_CACHE_LIMIT = 128

export function getToolSet(query: Record<string, unknown>): GeneratedTool[] {
  const key = toolSetCacheKey(query)
  const cached = toolSetCache.get(key)
  if (cached) return cached

  const selected = selectTools(ALL_TOOLS, parseToolFilter(query))
  // Bounded on purpose: the key is caller-influenced, and this is only an
  // optimisation, so declining to cache beyond the cap is always correct.
  if (toolSetCache.size < TOOL_SET_CACHE_LIMIT) toolSetCache.set(key, selected)
  return selected
}

/**
 * The server's whole telemetry surface: one single-line JSON record, on stderr,
 * for failures only.
 *
 * The zero-request-logging stance exists because API keys travel in the URL on
 * the /mcp/k/<key> fallback, and it left on-call unable to tell "no traffic"
 * from "every upstream call failing". This closes that without weakening the
 * stance: only structural facts are logged — never the URL, never the caller's
 * key, never tool arguments, and never an error *message*, which can quote the
 * caller's data (and, for an API that echoes it, the key itself). The tool name
 * is safe because an unknown name is refused before this point, so it is always
 * one of the generated names.
 */
export function logEvent(
  level: 'warn' | 'error',
  msg: string,
  fields: Record<string, string | number>,
): void {
  console.error(JSON.stringify({ level, msg, ...fields }))
}

export function newRequestId(): string {
  return randomUUID()
}

export function createMcpServer(options: {
  tools: GeneratedTool[]
  context: CallContext
  /** Correlates every line this request logs. Generated when absent. */
  requestId?: string
}): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  )

  const requestId = options.requestId ?? newRequestId()
  const byName = new Map(options.tools.map((tool) => [tool.definition.name, tool]))

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: options.tools.map((tool) => tool.definition),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name
    const tool = byName.get(name)
    if (!tool) {
      // Two different failures that must not be conflated.
      //
      // `byName` is built from the FILTERED set, so a tool excluded by
      // ?ops= / ?resources= is refused here and not merely hidden from
      // tools/list. Without this the filter would be advisory: a ?ops=read
      // connection could still invoke a delete by naming it directly. That
      // refusal stays an `isError` result on purpose — it is addressed to the
      // model, which can pick a different tool and carry on.
      if (ALL_TOOL_NAMES.has(name)) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Tool '${name}' is not available on this connection — its operation or resource is excluded by the ?ops= / ?resources= filter in the connect URL.`,
            },
          ],
        }
      }
      // A name that exists nowhere is a protocol-level mistake, and the spec
      // names it as the canonical -32602. Clients key on that code to refresh a
      // stale tool list or strip a hallucinated name; an `isError` result
      // instead hands "Unknown tool" back to the model, which retries variants.
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool '${name}'.`)
    }

    const startedAt = Date.now()
    try {
      const result = await callTool(tool, request.params.arguments ?? {}, options.context)
      return {
        // Compact on purpose: indentation was ~19% of every read response, paid
        // out of the caller's context window on every single call.
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      }
    } catch (error) {
      logEvent('error', 'tool_call_failed', {
        requestId,
        tool: name,
        error: error instanceof Error ? error.name : typeof error,
        durationMs: Date.now() - startedAt,
      })
      return {
        isError: true,
        // The caller's key is passed so it can be exact-matched out of the
        // message. Confetti enforces no key format, so shape-matching alone
        // would not hold the "key never reaches a client" constraint.
        content: [{ type: 'text' as const, text: toolErrorMessage(error, name, options.context.apiKey) }],
      }
    }
  })

  return server
}
