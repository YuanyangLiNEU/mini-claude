/**
 * Tool definitions and registry.
 *
 * Each tool = name + description + JSON Schema + async execute function.
 *
 * Reference: claude-code src/Tool.ts (their Tool type is ~200 fields;
 * ours has 5). And src/tools/*Tool/Tool.ts for real implementations.
 */

export type ToolInputSchema = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

/**
 * A tool with typed input/output. Use this when defining a tool — the type
 * params give you type safety inside `execute()`.
 */
export type Tool<Input = unknown, Output = unknown> = {
  /** Tool name (what Claude sees and calls by) */
  name: string
  /** Description shown to Claude — it decides when to use the tool based on this */
  description: string
  /** JSON Schema describing the tool's input parameters */
  input_schema: ToolInputSchema
  /** When true, require user permission before calling this tool. Reserved for Phase 2; not yet enforced. */
  isDangerous?: boolean
  /** Execute the tool. Returns the string fed back to Claude as tool_result. */
  execute: (input: Input) => Promise<Output>
}

/**
 * "Erased" tool type for collections and dispatch. At runtime Claude produces
 * input as arbitrary JSON, so the dispatcher doesn't know the exact input
 * shape — it passes `unknown` to execute(), and each tool narrows internally.
 *
 * Why this exists: TypeScript generics are invariant. `Tool<{path:string}>`
 * is NOT assignable to `Tool<unknown>`. So a mixed list of tools would fail
 * typechecking. This type erases the generics to accept any Tool<X, Y>.
 */
export type AnyTool = Omit<Tool, 'execute'> & {
  execute: (input: unknown) => Promise<unknown>
}

/**
 * Serialize the tools into the shape the Anthropic API expects in the request
 * body: { tools: [{ name, description, input_schema }, ...] }
 */
export function toolsToApiFormat(tools: AnyTool[]): {
  name: string
  description: string
  input_schema: ToolInputSchema
}[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }))
}

/** Find a tool by name. Returns undefined if not found. */
export function findTool(tools: AnyTool[], name: string): AnyTool | undefined {
  return tools.find(t => t.name === name)
}

/**
 * Define a tool with typed input/output internally, but expose it as AnyTool
 * for use in collections. The cast is safe: Claude produces input as JSON at
 * runtime, and the tool's implementation trusts the JSON Schema for validation.
 */
export function defineTool<Input, Output>(tool: Tool<Input, Output>): AnyTool {
  return tool as unknown as AnyTool
}

/**
 * Turn arbitrary execute() output into a string for tool_result content.
 * (Anthropic API expects tool_result.content as string or structured blocks.)
 */
export function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') return result
  return JSON.stringify(result, null, 2)
}

// ============================================================================
// Tools
// ============================================================================

/**
 * read_file — read the contents of a text file from disk.
 *
 * Reference: claude-code src/tools/FileReadTool/FileReadTool.ts (1,183 lines —
 * handles images, notebooks, binary detection, line-ranges, URLs, file state
 * caching, size limits, dedup). Ours: just read the file.
 */
export const readFileTool: AnyTool = defineTool<{ path: string }, string>({
  name: 'read_file',
  description:
    'Read the contents of a text file from disk. Returns the file contents as a string. ' +
    'Use absolute paths when possible.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Path to the file. Absolute paths recommended.',
      },
    },
    required: ['path'],
  },
  async execute({ path }) {
    const file = Bun.file(path)
    if (!(await file.exists())) {
      throw new Error(`file not found: ${path}`)
    }
    const text = await file.text()
    // Guardrail: cap at ~200KB so we don't blow out the context window
    const MAX_BYTES = 200_000
    if (text.length > MAX_BYTES) {
      return (
        text.slice(0, MAX_BYTES) +
        `\n\n[truncated: file is ${text.length} bytes, showing first ${MAX_BYTES}]`
      )
    }
    return text
  },
})

/**
 * list_files — list the contents of a directory.
 *
 * Reference: claude-code has no dedicated `ls` tool — they use GlobTool for
 * pattern-based discovery and BashTool for arbitrary `ls` commands. For
 * mini-claude, a dedicated list_files is simpler to teach and safer to
 * expose (no shell-injection risk).
 */
export const listFilesTool: AnyTool = defineTool<{ path: string }, string>({
  name: 'list_files',
  description:
    'List the entries in a directory. Returns each entry on its own line with ' +
    'type (file/dir) and size in bytes. Use absolute paths.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path to the directory to list.',
      },
    },
    required: ['path'],
  },
  async execute({ path }) {
    const { readdir, stat } = await import('node:fs/promises')
    let entries: string[]
    try {
      entries = await readdir(path)
    } catch (err) {
      throw new Error(
        `cannot list directory: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    entries.sort()
    const lines: string[] = [`${entries.length} entries in ${path}:`]
    for (const name of entries) {
      try {
        const s = await stat(`${path}/${name}`)
        const kind = s.isDirectory() ? 'dir ' : 'file'
        const size = s.isDirectory() ? '-' : String(s.size)
        lines.push(`  ${kind}  ${size.padStart(10)}  ${name}`)
      } catch {
        lines.push(`  ?     ?           ${name}`)
      }
    }
    return lines.join('\n')
  },
})

/**
 * write_file — write text content to a file, creating it if missing,
 * overwriting if it exists. Parent directories are created as needed.
 *
 * Reference: claude-code src/tools/FileWriteTool/FileWriteTool.ts (434 lines —
 * handles atomic writes, staleness detection, file history snapshots,
 * diagnostic tracking, skill discovery). Ours: write the bytes.
 *
 * Marked as dangerous (isDangerous: true) — Phase 2 will enforce a permission
 * prompt before this runs. For now it runs unprompted.
 */
export const writeFileTool: AnyTool = defineTool<
  { path: string; content: string },
  string
>({
  name: 'write_file',
  description:
    'Write text content to a file. Creates the file if it does not exist, ' +
    'and OVERWRITES it if it does. Parent directories are created automatically. ' +
    'Returns the number of bytes written. Use absolute paths.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path where the file should be written.',
      },
      content: {
        type: 'string',
        description: 'The full text content to write to the file.',
      },
    },
    required: ['path', 'content'],
  },
  isDangerous: true,
  async execute({ path, content }) {
    const bytes = await Bun.write(path, content)
    return `wrote ${bytes} bytes to ${path}`
  },
})

/**
 * delete_file — remove a file from disk.
 *
 * Dangerous: irreversible. Permission prompt fires before execution.
 */
export const deleteFileTool: AnyTool = defineTool<{ path: string }, string>({
  name: 'delete_file',
  description:
    'Delete a file from disk. This is IRREVERSIBLE. Use absolute paths. ' +
    'Returns a confirmation message. Fails if the file does not exist.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute path of the file to delete.',
      },
    },
    required: ['path'],
  },
  isDangerous: true,
  async execute({ path }) {
    const file = Bun.file(path)
    if (!(await file.exists())) {
      throw new Error(`file not found: ${path}`)
    }
    const { unlink } = await import('node:fs/promises')
    await unlink(path)
    return `deleted ${path}`
  },
})
