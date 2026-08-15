import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { buildTools, type GeneratedTool } from '../tools/definitions.js'
import { parseToolFilter, selectTools, toolSetCacheKey } from '../tools/filter.js'
import { callTool, type CallContext } from '../tools/dispatch.js'
import { toolErrorMessage } from '../tools/errors.js'

export const SERVER_NAME = 'confetti-mcp'
export const SERVER_VERSION = '0.1.0'

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

export function getToolSet(query: Record<string, unknown>): GeneratedTool[] {
  const key = toolSetCacheKey(query)
  const cached = toolSetCache.get(key)
  if (cached) return cached

  const selected = selectTools(ALL_TOOLS, parseToolFilter(query))
  toolSetCache.set(key, selected)
  return selected
}

export function createMcpServer(options: { tools: GeneratedTool[]; context: CallContext }): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  )

  const byName = new Map(options.tools.map((tool) => [tool.definition.name, tool]))

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: options.tools.map((tool) => tool.definition),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name
    const tool = byName.get(name)
    if (!tool) {
      // `byName` is built from the FILTERED set, so a tool excluded by
      // ?ops= / ?resources= is refused here and not merely hidden from
      // tools/list. Without this the filter would be advisory: a ?ops=read
      // connection could still invoke a delete by naming it directly.
      const text = ALL_TOOL_NAMES.has(name)
        ? `Tool '${name}' is not available on this connection — its operation or resource is excluded by the ?ops= / ?resources= filter in the connect URL.`
        : `Unknown tool '${name}'.`
      return {
        isError: true,
        content: [{ type: 'text' as const, text }],
      }
    }

    try {
      const result = await callTool(tool, request.params.arguments ?? {}, options.context)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      }
    } catch (error) {
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
