/**
 * MCP tool loader — reads .mcp.json, connects to servers, returns AnyTool[].
 *
 * Converts MCP tool schemas into the same AnyTool format as built-in tools.
 * When Claude calls an MCP tool, execute() routes the call to the right server.
 *
 * Tool naming: mcp__<serverName>__<toolName> (same convention as Claude Code).
 *
 * Reference: claude-code src/services/mcp/mcpStringUtils.ts (normalization),
 * src/services/mcp/client.ts:fetchToolsForClient (discovery).
 */

import { StdioMcpClient, HttpMcpClient, type McpClient, type McpToolSchema } from './client.ts'
import { makeLogger } from '../debug.ts'
import type { AnyTool, ToolInputSchema } from '../tools.ts'

const log = makeLogger('mcp')

// ── Config ──────────────────────────────────────────────────────────────────

type StdioServerConfig = {
  type?: 'stdio'       // default if type is omitted
  command: string
  args?: string[]
  env?: Record<string, string>
}

type HttpServerConfig = {
  type: 'http'
  url: string
  headers?: Record<string, string>
}

type McpServerConfig = StdioServerConfig | HttpServerConfig

type McpConfig = {
  mcpServers: Record<string, McpServerConfig>
}

async function readConfig(configPath: string): Promise<McpConfig | null> {
  try {
    const file = Bun.file(configPath)
    if (!(await file.exists())) return null
    return (await file.json()) as McpConfig
  } catch (err) {
    log.warn('failed to read MCP config', { path: configPath, err })
    return null
  }
}

// ── Tool conversion ─────────────────────────────────────────────────────────

function normalizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_')
}

function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeName(serverName)}__${normalizeName(toolName)}`
}

function mcpToolToAnyTool(
  client: McpClient,
  serverName: string,
  schema: McpToolSchema,
): AnyTool {
  const fullName = mcpToolName(serverName, schema.name)
  return {
    name: fullName,
    description: `[MCP: ${serverName}] ${schema.description}`,
    input_schema: schema.inputSchema as ToolInputSchema,
    isDangerous: false,
    async execute(input: unknown) {
      const result = await client.callTool(
        schema.name,
        (input ?? {}) as Record<string, unknown>,
      )
      if (result.isError) {
        throw new Error(
          result.content.map(c => c.text ?? '').join('\n') || 'MCP tool error',
        )
      }
      return result.content.map(c => c.text ?? '').join('\n')
    },
  }
}

// ── Server connection ───────────────────────────────────────────────────────

async function connectServer(
  serverName: string,
  config: McpServerConfig,
): Promise<McpClient> {
  if (config.type === 'http') {
    return HttpMcpClient.connect(serverName, config.url, config.headers)
  }
  // Default: stdio
  const stdio = config as StdioServerConfig
  return StdioMcpClient.connect(serverName, stdio.command, stdio.args, stdio.env)
}

// ── Public API ──────────────────────────────────────────────────────────────

const connectedClients: McpClient[] = []

/**
 * Load MCP tools from .mcp.json. Connects to each server, discovers tools,
 * and returns them as AnyTool[]. Servers stay alive until shutdown.
 */
export async function loadMcpTools(configPath = '.mcp.json'): Promise<AnyTool[]> {
  const config = await readConfig(configPath)
  if (!config?.mcpServers || Object.keys(config.mcpServers).length === 0) {
    log.debug('no MCP servers configured')
    return []
  }

  const allTools: AnyTool[] = []

  for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
    try {
      const client = await connectServer(serverName, serverConfig)
      connectedClients.push(client)

      const schemas = await client.listTools()
      for (const schema of schemas) {
        allTools.push(mcpToolToAnyTool(client, serverName, schema))
      }
    } catch (err) {
      log.warn(`failed to connect to MCP server "${serverName}"`, {
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  log.info('MCP tools loaded', {
    servers: connectedClients.length,
    tools: allTools.map(t => t.name),
  })

  return allTools
}

/**
 * Shut down all connected MCP servers.
 */
export function shutdownMcpServers(): void {
  for (const client of connectedClients) {
    client.shutdown()
  }
  connectedClients.length = 0
}
