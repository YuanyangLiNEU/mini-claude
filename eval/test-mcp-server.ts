/**
 * Minimal MCP server for eval testing. Speaks JSON-RPC over stdio.
 *
 * Exposes two tools:
 *   - echo(message: string) → returns the message back
 *   - add(a: number, b: number) → returns the sum
 *
 * Usage: bun run eval/test-mcp-server.ts
 */

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo a message back. Useful for testing.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message to echo back' },
      },
      required: ['message'],
    },
  },
  {
    name: 'add',
    description: 'Add two numbers together and return the sum.',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number', description: 'First number' },
        b: { type: 'number', description: 'Second number' },
      },
      required: ['a', 'b'],
    },
  },
]

// ── JSON-RPC handler ────────────────────────────────────────────────────────

type JsonRpcRequest = {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: Record<string, unknown>
}

type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: number | string
  result?: unknown
  error?: { code: number; message: string }
}

function handleRequest(req: JsonRpcRequest): JsonRpcResponse {
  switch (req.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocolVersion: '2025-03-26',
          serverInfo: { name: 'test-mcp-server', version: '1.0.0' },
          capabilities: { tools: {} },
        },
      }

    case 'notifications/initialized':
      // Client notification — no response needed, but we return one to be safe
      return { jsonrpc: '2.0', id: req.id, result: {} }

    case 'tools/list':
      return { jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } }

    case 'tools/call': {
      const name = (req.params as { name: string })?.name
      const args = (req.params as { arguments: Record<string, unknown> })?.arguments ?? {}

      if (name === 'echo') {
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: {
            content: [{ type: 'text', text: String(args.message ?? '') }],
          },
        }
      }

      if (name === 'add') {
        const sum = Number(args.a ?? 0) + Number(args.b ?? 0)
        return {
          jsonrpc: '2.0',
          id: req.id,
          result: {
            content: [{ type: 'text', text: String(sum) }],
          },
        }
      }

      return {
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32601, message: `unknown tool: ${name}` },
      }
    }

    default:
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32601, message: `unknown method: ${req.method}` },
      }
  }
}

// ── stdio transport ─────────────────────────────────────────────────────────

const decoder = new TextDecoder()
let buffer = ''

process.stdin.on('data', (chunk: Buffer) => {
  buffer += decoder.decode(chunk, { stream: true })

  // JSON-RPC over stdio uses Content-Length headers (like LSP)
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) break

    const header = buffer.slice(0, headerEnd)
    const match = header.match(/Content-Length:\s*(\d+)/i)
    if (!match) {
      // Skip malformed header
      buffer = buffer.slice(headerEnd + 4)
      continue
    }

    const contentLength = parseInt(match[1]!, 10)
    const bodyStart = headerEnd + 4
    if (buffer.length < bodyStart + contentLength) break // need more data

    const body = buffer.slice(bodyStart, bodyStart + contentLength)
    buffer = buffer.slice(bodyStart + contentLength)

    try {
      const req = JSON.parse(body) as JsonRpcRequest

      // notifications/initialized has no id — don't respond
      if (req.method === 'notifications/initialized') continue

      const resp = handleRequest(req)
      const respJson = JSON.stringify(resp)
      const respMsg = `Content-Length: ${Buffer.byteLength(respJson)}\r\n\r\n${respJson}`
      process.stdout.write(respMsg)
    } catch {
      // Ignore parse errors
    }
  }
})
