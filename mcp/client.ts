/**
 * MCP client — connects to an MCP server via stdio or HTTP (JSON-RPC 2.0).
 *
 * Two transports:
 *   - stdio: spawns a local subprocess, communicates via Content-Length framed JSON-RPC
 *   - http: sends JSON-RPC as HTTP POST to a remote URL
 *
 * Both share the same interface: listTools(), callTool(), shutdown().
 *
 * Reference: claude-code src/services/mcp/client.ts (3,300 lines — supports
 * stdio/SSE/HTTP/WebSocket, OAuth, reconnection, caching). Ours: stdio + HTTP.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { makeLogger } from '../debug.ts'

const log = makeLogger('mcp')

// ── Types ───────────────────────────────────────────────────────────────────

export type McpToolSchema = {
  name: string
  description: string
  inputSchema: {
    type: string
    properties: Record<string, unknown>
    required?: string[]
  }
}

export type McpToolResult = {
  content: { type: string; text?: string }[]
  isError?: boolean
}

// ── Common interface ────────────────────────────────────────────────────────

export interface McpClient {
  readonly serverName: string
  listTools(): Promise<McpToolSchema[]>
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>
  shutdown(): void
}

// ── HTTP transport ──────────────────────────────────────────────────────────

export class HttpMcpClient implements McpClient {
  readonly serverName: string
  private url: string
  private headers: Record<string, string>
  private nextId = 1
  private sessionUrl: string | null = null

  private constructor(serverName: string, url: string, headers: Record<string, string>) {
    this.serverName = serverName
    this.url = url
    this.headers = headers
  }

  static async connect(
    serverName: string,
    url: string,
    headers: Record<string, string> = {},
  ): Promise<HttpMcpClient> {
    log.info(`connecting to MCP server "${serverName}" via HTTP`, { url })

    const client = new HttpMcpClient(serverName, url, headers)

    const initResult = await client.request('initialize', {
      protocolVersion: '2025-03-26',
      clientInfo: { name: 'mini-claude', version: '1.0.0' },
      capabilities: {},
    }) as { serverInfo?: { name?: string } }

    log.info(`[${serverName}] initialized`, { server: initResult.serverInfo?.name })

    // Send initialized notification
    await client.notify('notifications/initialized')

    return client
  }

  async listTools(): Promise<McpToolSchema[]> {
    const result = await this.request('tools/list') as { tools: McpToolSchema[] }
    log.info(`[${this.serverName}] discovered ${result.tools.length} tools`, {
      names: result.tools.map(t => t.name),
    })
    return result.tools
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    log.debug(`[${this.serverName}] calling tool`, { name, args })
    return await this.request('tools/call', { name, arguments: args }) as McpToolResult
  }

  shutdown(): void {
    log.info(`[${this.serverName}] HTTP client shut down`)
    // No process to kill — just a no-op
  }

  private async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++
    const body: Record<string, unknown> = { jsonrpc: '2.0', id, method }
    if (params) body.params = params

    const targetUrl = this.sessionUrl ?? this.url
    const resp = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...this.headers },
      body: JSON.stringify(body),
    })

    // Track session URL if server returns one via Mcp-Session header
    const sessionHeader = resp.headers.get('mcp-session')
    if (sessionHeader) this.sessionUrl = sessionHeader

    if (!resp.ok) {
      throw new Error(`MCP HTTP error ${resp.status}: ${await resp.text()}`)
    }

    const result = await this.parseResponse(resp)
    if (result.error) {
      throw new Error(`MCP error: ${result.error.message} (code ${result.error.code})`)
    }
    return result.result
  }

  /**
   * Parse response — handles both plain JSON and SSE (text/event-stream).
   * GitHub's MCP endpoint returns SSE format: "event: message\ndata: {...}\n\n"
   *
   * Limitation: reads the full response body and returns the first valid
   * JSON-RPC message. This works for single-response SSE (GitHub's current
   * behavior) but won't handle streaming SSE where a server sends multiple
   * messages over a long-lived connection. To support that, we'd need to
   * consume the stream incrementally with an async reader.
   */
  private async parseResponse(resp: Response): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
    const contentType = resp.headers.get('content-type') ?? ''

    if (contentType.includes('text/event-stream')) {
      // SSE: scan for "data: " lines, parse the JSON from each
      const text = await resp.text()
      for (const line of text.split('\n')) {
        if (line.startsWith('data: ')) {
          const json = line.slice(6)
          try {
            return JSON.parse(json) as { result?: unknown; error?: { code: number; message: string } }
          } catch { /* skip malformed lines */ }
        }
      }
      throw new Error('MCP SSE response contained no valid data lines')
    }

    // Plain JSON
    return (await resp.json()) as { result?: unknown; error?: { code: number; message: string } }
  }

  private async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    const body: Record<string, unknown> = { jsonrpc: '2.0', method }
    if (params) body.params = params

    const targetUrl = this.sessionUrl ?? this.url
    await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...this.headers },
      body: JSON.stringify(body),
    })
  }
}

// ── Stdio transport ─────────────────────────────────────────────────────────

type JsonRpcRequest = {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: Record<string, unknown>
}

type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

export class StdioMcpClient implements McpClient {
  private proc: ChildProcess
  private nextId = 1
  private pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (reason: Error) => void
  }>()
  private buffer = ''
  readonly serverName: string

  private constructor(serverName: string, proc: ChildProcess) {
    this.serverName = serverName
    this.proc = proc

    proc.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString()
      this.drainBuffer()
    })

    proc.stderr!.on('data', (chunk: Buffer) => {
      log.debug(`[${serverName}] stderr`, chunk.toString().trim())
    })

    proc.on('exit', (code) => {
      log.info(`[${serverName}] process exited`, { code })
      for (const [id, { reject }] of this.pending) {
        reject(new Error(`MCP server "${serverName}" exited (code ${code})`))
        this.pending.delete(id)
      }
    })
  }

  static async connect(
    serverName: string,
    command: string,
    args: string[] = [],
    env?: Record<string, string>,
  ): Promise<StdioMcpClient> {
    log.info(`connecting to MCP server "${serverName}" via stdio`, { command, args })

    const proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })

    const client = new StdioMcpClient(serverName, proc)

    const initResult = await client.request('initialize', {
      protocolVersion: '2025-03-26',
      clientInfo: { name: 'mini-claude', version: '1.0.0' },
      capabilities: {},
    }) as { serverInfo?: { name?: string } }

    log.info(`[${serverName}] initialized`, { server: initResult.serverInfo?.name })

    client.notify('notifications/initialized')

    return client
  }

  async listTools(): Promise<McpToolSchema[]> {
    const result = await this.request('tools/list') as { tools: McpToolSchema[] }
    log.info(`[${this.serverName}] discovered ${result.tools.length} tools`, {
      names: result.tools.map(t => t.name),
    })
    return result.tools
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    log.debug(`[${this.serverName}] calling tool`, { name, args })
    return await this.request('tools/call', { name, arguments: args }) as McpToolResult
  }

  shutdown(): void {
    log.info(`[${this.serverName}] shutting down`)
    this.proc.kill('SIGTERM')
  }

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++
    const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method }
    if (params) msg.params = params

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send(msg)

      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`MCP request timed out: ${method} (id=${id})`))
        }
      }, 30_000)
    })
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    const msg: Record<string, unknown> = { jsonrpc: '2.0', method }
    if (params) msg.params = params
    this.send(msg)
  }

  private send(msg: unknown): void {
    const json = JSON.stringify(msg)
    const frame = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`
    this.proc.stdin!.write(frame)
  }

  private drainBuffer(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) break

      const header = this.buffer.slice(0, headerEnd)
      const match = header.match(/Content-Length:\s*(\d+)/i)
      if (!match) {
        this.buffer = this.buffer.slice(headerEnd + 4)
        continue
      }

      const contentLength = parseInt(match[1]!, 10)
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + contentLength) break

      const body = this.buffer.slice(bodyStart, bodyStart + contentLength)
      this.buffer = this.buffer.slice(bodyStart + contentLength)

      try {
        const resp = JSON.parse(body) as JsonRpcResponse
        const pending = this.pending.get(resp.id)
        if (pending) {
          this.pending.delete(resp.id)
          if (resp.error) {
            pending.reject(new Error(`MCP error: ${resp.error.message} (code ${resp.error.code})`))
          } else {
            pending.resolve(resp.result)
          }
        }
      } catch {
        log.warn(`[${this.serverName}] failed to parse response`)
      }
    }
  }
}
