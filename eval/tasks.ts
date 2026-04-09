/**
 * Task definitions for mini-claude evaluation.
 *
 * Each task describes:
 *   - a goal (what the simulated user wants)
 *   - success criteria (how the evaluator decides the goal is met)
 *   - an opening message (the first thing the user says)
 *   - optional persona (colors the evaluator's judgments)
 *
 * The evaluator is an LLM that reads what mini-claude does each turn and
 * decides how to respond — including whether to approve or deny permission
 * prompts for dangerous tools.
 */

import { mkdir, rm, unlink } from 'node:fs/promises'
import type { Task } from './types.ts'

export const SANDBOX = `${import.meta.dir}/sandbox`

async function ensureSandbox(): Promise<void> {
  await mkdir(SANDBOX, { recursive: true })
}

async function rmIfExists(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {}
}

export const TASKS: Task[] = [
  // ---- Capability: read ----
  {
    name: 'read_file_capability',
    goal: `Find out what's in ${SANDBOX}/notes.txt`,
    successCriteria: [
      'mini-claude called read_file with the correct path',
      'mini-claude surfaced the actual file contents in its response',
    ],
    openingMessage: `What does ${SANDBOX}/notes.txt contain?`,
    setupDescription: `created ${SANDBOX}/notes.txt with content "meeting at 3pm, bring laptop"`,
    setup: async () => {
      await ensureSandbox()
      await Bun.write(`${SANDBOX}/notes.txt`, 'meeting at 3pm, bring laptop')
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/notes.txt`)
    },
  },

  // ---- Capability: list directory ----
  {
    name: 'list_dir_capability',
    goal: `See what files exist in ${SANDBOX}/fruits`,
    successCriteria: [
      'mini-claude called list_files with the correct path',
      'mini-claude named apple.txt and banana.txt in its response',
    ],
    openingMessage: `What files are in ${SANDBOX}/fruits?`,
    setupDescription: `created directory ${SANDBOX}/fruits/ containing apple.txt and banana.txt`,
    setup: async () => {
      await ensureSandbox()
      await mkdir(`${SANDBOX}/fruits`, { recursive: true })
      await Bun.write(`${SANDBOX}/fruits/apple.txt`, 'a')
      await Bun.write(`${SANDBOX}/fruits/banana.txt`, 'b')
    },
    cleanup: async () => {
      try {
        await rm(`${SANDBOX}/fruits`, { recursive: true, force: true })
      } catch {}
    },
  },

  // ---- Capability: write (with approval) ----
  {
    name: 'write_file_approved',
    goal: `Get "hello from eval" written to ${SANDBOX}/write.txt`,
    successCriteria: [
      'mini-claude called write_file with the correct path and content',
      'you approved the write when asked for permission',
      'mini-claude confirmed completion',
    ],
    openingMessage: `Please write "hello from eval" to ${SANDBOX}/write.txt`,
    persona: `You want the write to happen — approve when asked for permission.`,
    setupDescription: `ensured ${SANDBOX}/write.txt does NOT exist`,
    setup: async () => {
      await ensureSandbox()
      await rmIfExists(`${SANDBOX}/write.txt`)
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/write.txt`)
    },
  },

  // ---- Capability: chain tools together ----
  {
    name: 'chain_read_then_write',
    goal: `Have ${SANDBOX}/source.txt's contents transformed to uppercase and written to ${SANDBOX}/out.txt`,
    successCriteria: [
      'mini-claude read source.txt',
      'mini-claude wrote to out.txt',
      'the content written was UPPERCASE',
      'you approved the write when asked',
    ],
    openingMessage: `Read ${SANDBOX}/source.txt and write its contents in UPPERCASE to ${SANDBOX}/out.txt.`,
    persona: `You want the transformation to happen — approve the write.`,
    setupDescription: `created ${SANDBOX}/source.txt with content "hello world"; ensured ${SANDBOX}/out.txt does NOT exist`,
    setup: async () => {
      await ensureSandbox()
      await Bun.write(`${SANDBOX}/source.txt`, 'hello world')
      await rmIfExists(`${SANDBOX}/out.txt`)
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/source.txt`)
      await rmIfExists(`${SANDBOX}/out.txt`)
    },
  },

  // ---- Error recovery: missing file ----
  {
    name: 'missing_file_recovery',
    goal: `Get the contents of ${SANDBOX}/nonexistent-xyz.txt — but it doesn't exist, so you want to be told that clearly`,
    successCriteria: [
      'mini-claude attempted to call read_file',
      'mini-claude told you clearly that the file does not exist',
      'mini-claude did NOT fabricate any file contents',
    ],
    openingMessage: `Read ${SANDBOX}/nonexistent-xyz.txt and tell me what's in it.`,
    setupDescription: `ensured ${SANDBOX}/nonexistent-xyz.txt does NOT exist`,
    setup: async () => {
      await ensureSandbox()
      await rmIfExists(`${SANDBOX}/nonexistent-xyz.txt`)
    },
  },

  // ---- Capability: delete a file ----
  {
    name: 'delete_file_capability',
    goal: `Get ${SANDBOX}/old.txt deleted from disk`,
    successCriteria: [
      'mini-claude called delete_file with the correct path',
      'you approved the deletion when asked for permission',
      'mini-claude confirmed the file was deleted (no errors in the tool result)',
    ],
    openingMessage: `Please delete the file at ${SANDBOX}/old.txt — I don't need it anymore.`,
    persona: `You want the file gone — approve the deletion when asked for permission.`,
    setupDescription: `created ${SANDBOX}/old.txt with content "goodbye"`,
    setup: async () => {
      await ensureSandbox()
      await Bun.write(`${SANDBOX}/old.txt`, 'goodbye')
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/old.txt`)
    },
  },

  // ---- Permission denied recovery ----
  {
    name: 'permission_denied_recovery',
    goal: `You asked mini-claude to write a file, but after seeing the exact path you realize you don't want it. You'll deny permission. mini-claude should tell you clearly that the write did not happen.`,
    successCriteria: [
      'mini-claude asked for permission to use write_file',
      'you denied the permission',
      'mini-claude acknowledged that the write did not happen (did not claim success)',
    ],
    openingMessage: `Please write "should not land" to ${SANDBOX}/blocked.txt`,
    persona: `You want to SEE mini-claude ask for permission, then DENY it. You are testing whether mini-claude honestly reports the denial. Any path containing 'blocked' is off-limits for you — deny permission when asked.`,
    setupDescription: `ensured ${SANDBOX}/blocked.txt does NOT exist`,
    setup: async () => {
      await ensureSandbox()
      await rmIfExists(`${SANDBOX}/blocked.txt`)
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/blocked.txt`)
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Web Search tasks (server-side tool — no permission prompts needed)
  // ═══════════════════════════════════════════════════════════════════════════

  // ---- Web search: basic factual query ----
  {
    name: 'web_search_basic',
    goal: 'Get a factual answer to a question that requires current information beyond training data',
    successCriteria: [
      'mini-claude performed a web search (you see a search tool call in the output)',
      'mini-claude provided a concrete, specific answer (e.g. a name, not just "I found some results")',
      'the answer is plausible and consistent with what you know',
      'the answer is not a refusal or "I cannot search the web"',
    ],
    openingMessage: 'Who is the current Secretary-General of the United Nations?',
    maxTurns: 4,
  },

  // ---- Web search: synthesis from results ----
  {
    name: 'web_search_synthesis',
    goal: 'Get a synthesized comparison that requires searching for current data about two things',
    successCriteria: [
      'mini-claude performed at least one web search',
      'mini-claude mentioned specific version numbers (not vague like "the latest version")',
      'the response compares the two items with concrete facts',
      'the version numbers and comparison are plausible (not obviously fabricated)',
    ],
    openingMessage: 'What are the latest stable versions of Bun and Deno? Which one is newer?',
    maxTurns: 4,
  },

  // ---- Web search + file tool chain ----
  {
    name: 'web_search_then_write',
    goal: `Search for information online and save a summary to ${SANDBOX}/research.txt`,
    successCriteria: [
      'mini-claude performed a web search',
      'mini-claude called write_file to save results to the correct path',
      'you approved the write when asked for permission',
      'the content written is a meaningful summary (not empty or generic filler)',
      'mini-claude confirmed the file was written',
    ],
    openingMessage: `Search the web for "what is MCP model context protocol" and save a 2-3 sentence summary to ${SANDBOX}/research.txt`,
    persona: 'You want the research saved — approve the write when asked for permission.',
    setupDescription: `ensured ${SANDBOX}/research.txt does NOT exist`,
    setup: async () => {
      await ensureSandbox()
      await rmIfExists(`${SANDBOX}/research.txt`)
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/research.txt`)
    },
    maxTurns: 6,
  },

  // ---- Web search: no search needed ----
  {
    name: 'web_search_not_needed',
    goal: 'Get a correct answer to a general knowledge question — searching is acceptable but not required',
    successCriteria: [
      'mini-claude answered the question correctly (list comprehension is a concise way to create lists)',
      'the answer includes a working Python code example',
      'the answer is direct and not padded with unnecessary information',
    ],
    openingMessage: 'What is a Python list comprehension? Give me a short example.',
    maxTurns: 3,
  },

  // ---- Web search: multi-turn follow-up ----
  {
    name: 'web_search_followup',
    goal: 'Get an answer, then ask a follow-up question that builds on it',
    successCriteria: [
      'mini-claude performed a web search on the first question',
      'mini-claude gave a concrete answer about Rust (e.g. its creator, key features)',
      'after your follow-up, mini-claude provided relevant details (searched again or used knowledge)',
      'the follow-up answer is specific and builds on the first answer',
    ],
    openingMessage: 'Search the web: who created the Rust programming language and when was it first released?',
    persona: 'After the first answer, ask a follow-up like "What are the biggest companies using Rust in production right now?" to see if mini-claude can search again and provide current info.',
    maxTurns: 6,
  },

  // ---- Web search: specific formatting request ----
  {
    name: 'web_search_formatted',
    goal: 'Get web search results presented in a specific format the user requested',
    successCriteria: [
      'mini-claude performed a web search',
      'the response uses bullet points or a numbered list as requested',
      'each item includes a concrete fact (version number, feature name), not vague filler',
      'the TypeScript version mentioned is plausible (5.x range as of 2025)',
    ],
    openingMessage: 'Search the web and give me 3 bullet points about the latest TypeScript release. Include version number and key features.',
    maxTurns: 4,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // MCP tasks (external tool server via JSON-RPC over stdio)
  // Uses eval/test-mcp-server.ts as a test fixture.
  // ═══════════════════════════════════════════════════════════════════════════

  // ---- MCP: discover and use echo tool ----
  {
    name: 'mcp_echo_tool',
    goal: 'Use the MCP echo tool to echo back a specific message',
    successCriteria: [
      'mini-claude called a tool named mcp__test__echo or similar',
      'the tool call included the message "hello from MCP"',
      'mini-claude showed the echoed result in its response',
    ],
    openingMessage: 'Use the echo tool to echo "hello from MCP".',
    maxTurns: 4,
  },

  // ---- MCP: use add tool for arithmetic ----
  {
    name: 'mcp_add_tool',
    goal: 'Use the MCP add tool to compute a sum',
    successCriteria: [
      'mini-claude called a tool named mcp__test__add or similar',
      'the tool call included arguments for two numbers',
      'mini-claude reported the correct sum (42) in its response',
    ],
    openingMessage: 'Use the add tool to compute 17 + 25.',
    maxTurns: 4,
  },

  // ---- MCP: tool discovery ----
  {
    name: 'mcp_tool_discovery',
    goal: 'Confirm that MCP tools are visible and listed alongside built-in tools',
    successCriteria: [
      'mini-claude listed tools that include both built-in tools (read_file, write_file) and MCP tools (echo, add)',
      'the MCP tools have descriptions visible in the listing',
    ],
    openingMessage: 'What tools do you have available? List all of them.',
    maxTurns: 3,
  },

  // ---- MCP: chain MCP tool with file tool ----
  {
    name: 'mcp_chain_with_file',
    goal: `Use the MCP add tool to compute a sum, then save the result to ${SANDBOX}/sum.txt`,
    successCriteria: [
      'mini-claude called the MCP add tool',
      'mini-claude called write_file to save the result',
      'you approved the write when asked for permission',
      'the file content includes the correct sum (100)',
    ],
    openingMessage: `Use the add tool to compute 63 + 37, then save the result to ${SANDBOX}/sum.txt`,
    persona: 'You want the result saved — approve the write when asked for permission.',
    setupDescription: `ensured ${SANDBOX}/sum.txt does NOT exist`,
    setup: async () => {
      await ensureSandbox()
      await rmIfExists(`${SANDBOX}/sum.txt`)
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/sum.txt`)
    },
    maxTurns: 6,
  },

  // ---- MCP: unknown tool error handling ----
  {
    name: 'mcp_unknown_tool_recovery',
    goal: 'Ask mini-claude to use a tool that doesn\'t exist and see it handle the error gracefully',
    successCriteria: [
      'mini-claude attempted to use a tool or explained it doesn\'t have a "multiply" tool',
      'mini-claude did NOT fabricate a result — it either reported an error or used an alternative approach',
      'mini-claude gave a helpful response (e.g. suggested using add instead, or computed manually)',
    ],
    openingMessage: 'Use the multiply tool to compute 6 * 7.',
    maxTurns: 4,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // GitHub MCP tasks (requires GitHub MCP server configured + GITHUB_TOKEN)
  // These are integration tests against the real GitHub API.
  // ═══════════════════════════════════════════════════════════════════════════

  // ---- GitHub: read repo info ----
  {
    name: 'github_repo_info',
    goal: 'Get basic information about the YuanyangLiNEU/mini-claude repository',
    successCriteria: [
      'mini-claude called a GitHub MCP tool to get repo info',
      'mini-claude reported that the repo is written in TypeScript',
      'the response includes concrete details (language, description, or stars) not vague filler',
    ],
    openingMessage: 'What programming language is the YuanyangLiNEU/mini-claude repo written in?',
    maxTurns: 4,
  },

  // ---- GitHub: list issues ----
  {
    name: 'github_list_issues',
    goal: 'List the issues on the YuanyangLiNEU/mini-claude repository',
    successCriteria: [
      'mini-claude called a GitHub MCP tool to list issues',
      'mini-claude either listed specific issues or clearly stated there are no open issues',
      'the response is based on actual API data, not fabricated',
    ],
    openingMessage: 'Are there any open issues on the YuanyangLiNEU/mini-claude repo?',
    maxTurns: 4,
  },

  // ---- GitHub: read file from repo ----
  {
    name: 'github_read_file',
    goal: 'Read a specific file from the YuanyangLiNEU/mini-claude repository on GitHub',
    successCriteria: [
      'mini-claude called a GitHub MCP tool to read file contents',
      'mini-claude showed the actual content of package.json',
      'the content includes "mini-claude" as the package name (proving it read the real file)',
    ],
    openingMessage: 'Show me the contents of package.json from the YuanyangLiNEU/mini-claude repo on GitHub.',
    maxTurns: 4,
  },

  // ---- GitHub: create issue ----
  {
    name: 'github_create_issue',
    goal: 'Create a test issue on the YuanyangLiNEU/mini-claude repository',
    successCriteria: [
      'mini-claude called a GitHub MCP tool to create an issue',
      'the issue title includes "eval test"',
      'mini-claude confirmed the issue was created with an issue number',
    ],
    openingMessage: 'Create an issue on YuanyangLiNEU/mini-claude titled "eval test: MCP GitHub integration" with body "Automated test issue created by mini-claude eval. Safe to close."',
    persona: 'You want the issue created. If asked for confirmation, say yes.',
    maxTurns: 4,
  },

  // ---- GitHub: search and save to file ----
  {
    name: 'github_search_and_save',
    goal: 'Get recent commits from the mini-claude repo and save a summary to a local file',
    successCriteria: [
      'mini-claude called a GitHub MCP tool to get commits',
      'mini-claude called write_file to save the summary',
      'you approved the write when asked for permission',
      'the saved content references actual commit messages (not fabricated)',
    ],
    openingMessage: `List the 3 most recent commits on YuanyangLiNEU/mini-claude and save a summary to ${SANDBOX}/commits.txt`,
    persona: 'You want the summary saved — approve the write when asked for permission.',
    setupDescription: `ensured ${SANDBOX}/commits.txt does NOT exist`,
    setup: async () => {
      await ensureSandbox()
      await rmIfExists(`${SANDBOX}/commits.txt`)
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/commits.txt`)
    },
    maxTurns: 6,
  },
]
