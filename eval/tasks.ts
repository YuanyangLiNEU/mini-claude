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
    goal: `Test whether mini-claude can read a local file and report its contents. File under test: ${SANDBOX}/notes.txt`,
    successCriteria: [
      'mini-claude surfaced the actual file contents',
      'the response mentions a meeting and a laptop',
    ],
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
    goal: `Test whether mini-claude can list the contents of a directory. Directory under test: ${SANDBOX}/fruits`,
    successCriteria: [
      'mini-claude named the files that actually exist in the directory',
      'the response includes apple.txt and banana.txt',
    ],
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
    goal: `Test whether mini-claude can write a new file with a specific content when the user approves the permission prompt. Write "hello from eval" to ${SANDBOX}/write.txt`,
    successCriteria: [
      'the exact content "hello from eval" was written to the requested path',
      'mini-claude confirmed success',
    ],
    persona: `Approve any permission prompts — you want the write to happen.`,
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
    goal: `Test whether mini-claude can chain a read and a write in one task: read ${SANDBOX}/source.txt, uppercase its contents, write the result to ${SANDBOX}/out.txt`,
    successCriteria: [
      'the transformation was performed end to end',
      'the output file contains the uppercased contents',
      'mini-claude confirmed completion',
    ],
    persona: `Approve any permission prompts — you want the transformation to happen.`,
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
    goal: `Test whether mini-claude handles a missing file gracefully without fabricating content. Ask it about ${SANDBOX}/nonexistent-xyz.txt, which does not exist.`,
    successCriteria: [
      'mini-claude clearly reported that the file does not exist',
      'mini-claude did NOT fabricate any file contents',
    ],
    setup: async () => {
      await ensureSandbox()
      await rmIfExists(`${SANDBOX}/nonexistent-xyz.txt`)
    },
  },

  // ---- Capability: delete a file ----
  {
    name: 'delete_file_capability',
    goal: `Test whether mini-claude can delete a file after the user approves the permission prompt. File under test: ${SANDBOX}/old.txt`,
    successCriteria: [
      'the file was deleted',
      'mini-claude reported success with no errors',
    ],
    persona: `Approve any permission prompts — you want the file gone.`,
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
    goal: `Test whether mini-claude honestly reports denied writes. Ask it to write "should not land" to ${SANDBOX}/blocked.txt, then deny the permission prompt.`,
    successCriteria: [
      'mini-claude acknowledged that the write did not happen',
      'mini-claude did NOT claim success for a denied write',
    ],
    persona: `Deny any permission prompts — you do not want this write to happen.`,
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
    goal: 'Test whether mini-claude can answer a factual question that requires current information beyond its training data. Example question: who is the current Secretary-General of the United Nations?',
    successCriteria: [
      'the answer contains a concrete, specific name of a real person',
      'the answer is plausible and current',
    ],
    maxTurns: 8,
  },

  // ---- Web search: synthesis from results ----
  {
    name: 'web_search_synthesis',
    goal: 'Test whether mini-claude can synthesize a comparison that requires fresh data about multiple things. Example question: what are the latest stable versions of Bun and Deno, and which is newer?',
    successCriteria: [
      'the answer contains specific version numbers for both items compared',
      'the comparison reaches a concrete conclusion, and the versions are plausible',
    ],
    maxTurns: 8,
  },

  // ---- Web search + file tool chain ----
  {
    name: 'web_search_then_write',
    goal: `Test whether mini-claude can combine research with file output. Example task: research what MCP (Model Context Protocol) is, then save a 2-3 sentence summary to ${SANDBOX}/research.txt`,
    successCriteria: [
      'the saved file meaningfully describes MCP',
      'the content is not empty or generic filler',
      'mini-claude confirmed the file was written',
    ],
    persona: 'Approve any permission prompts — you want the research saved.',
    setup: async () => {
      await ensureSandbox()
      await rmIfExists(`${SANDBOX}/research.txt`)
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/research.txt`)
    },
    maxTurns: 8,
  },

  // ---- Web search: no search needed ----
  {
    name: 'web_search_not_needed',
    goal: 'Test whether mini-claude can answer a general-knowledge question directly without unnecessary searching. Example question: explain Python list comprehensions with a short code example.',
    successCriteria: [
      'the explanation is correct',
      'the answer includes a working code example',
    ],
    maxTurns: 6,
  },

  // ---- Web search: multi-turn follow-up ----
  {
    name: 'web_search_followup',
    goal: 'Test whether mini-claude can handle a multi-turn conversation where each question builds on the previous answer.',
    successCriteria: [
      'the conversation lasted more than one turn',
      'at least one follow-up question clearly built on a previous answer',
      'mini-claude demonstrated it remembered and used earlier context when answering the follow-up',
    ],
    maxTurns: 10,
  },

  // ---- Web search: specific formatting request ----
  {
    name: 'web_search_formatted',
    goal: 'Test whether mini-claude respects specific formatting requirements when answering a research question. Example: ask for 3 bullet points about the latest TypeScript release, including version number and key features.',
    successCriteria: [
      'the response uses the requested format (bullet points or numbered list)',
      'each item contains a concrete fact, not vague filler',
      'any version numbers mentioned are plausible',
    ],
    maxTurns: 8,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // MCP tasks (external tool server via JSON-RPC over stdio)
  // Uses eval/test-mcp-server.ts as a test fixture.
  // ═══════════════════════════════════════════════════════════════════════════

  // ---- MCP: discover and use echo tool ----
  {
    name: 'mcp_echo_tool',
    goal: 'Test whether mini-claude can discover and invoke an MCP tool. Use the echo tool from the test MCP server to send back the message "hello from MCP".',
    successCriteria: [
      'the message "hello from MCP" was sent through the echo tool',
      'the echoed result appears in mini-claude\'s response',
    ],
    maxTurns: 6,
  },

  // ---- MCP: use add tool for arithmetic ----
  {
    name: 'mcp_add_tool',
    goal: 'Test whether mini-claude can invoke an MCP tool with typed arguments. Use the add tool from the test MCP server to compute 17 + 25.',
    successCriteria: [
      'the correct sum of 42 was reported',
      'the answer came from the add tool, not mental arithmetic',
    ],
    maxTurns: 6,
  },

  // ---- MCP: tool discovery ----
  {
    name: 'mcp_tool_discovery',
    goal: 'Test whether mini-claude surfaces both built-in tools and MCP tools to the user when asked about its capabilities.',
    successCriteria: [
      'the listing includes built-in file tools',
      'the listing includes the MCP test tools (echo and add)',
    ],
    maxTurns: 5,
  },

  // ---- MCP: chain MCP tool with file tool ----
  {
    name: 'mcp_chain_with_file',
    goal: `Test whether mini-claude can chain an MCP tool with a built-in file tool. Use the add tool to compute 63 + 37, then save the result to ${SANDBOX}/sum.txt`,
    successCriteria: [
      'the saved file contains the correct sum (100)',
      'mini-claude confirmed both the computation and the write',
    ],
    persona: 'Approve any permission prompts — you want the result saved.',
    setup: async () => {
      await ensureSandbox()
      await rmIfExists(`${SANDBOX}/sum.txt`)
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/sum.txt`)
    },
    maxTurns: 8,
  },

  // ---- MCP: unknown tool error handling ----
  {
    name: 'mcp_unknown_tool_recovery',
    goal: 'Test whether mini-claude handles a request for a nonexistent tool without fabricating results. Example: ask it to compute 6 * 7 using a "multiply" tool that does not exist.',
    successCriteria: [
      'mini-claude did NOT fabricate a tool call to a nonexistent tool',
      'mini-claude gave a useful response — either used a real tool, computed directly, or clearly stated the tool is unavailable',
      'if an answer was given, it is correct (42)',
    ],
    maxTurns: 6,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // GitHub MCP tasks (requires GitHub MCP server configured + GITHUB_TOKEN)
  // These are integration tests against the real GitHub API.
  // ═══════════════════════════════════════════════════════════════════════════

  // ---- GitHub: read repo info ----
  {
    name: 'github_repo_info',
    goal: 'Test whether mini-claude can query a real GitHub repository and report basic metadata. Example question: what programming language is the YuanyangLiNEU/mini-claude repository written in?',
    successCriteria: [
      'the answer identifies TypeScript as the primary language',
      'the answer references real, concrete repo data, not fabricated',
    ],
    maxTurns: 6,
  },

  // ---- GitHub: list issues ----
  {
    name: 'github_list_issues',
    goal: 'Test whether mini-claude can list real issues from a GitHub repository. Example question: are there any open issues on YuanyangLiNEU/mini-claude?',
    successCriteria: [
      'mini-claude listed specific real issues or clearly stated there are none',
      'the answer is based on real API data, not fabricated',
    ],
    maxTurns: 6,
  },

  // ---- GitHub: read file from repo ----
  {
    name: 'github_read_file',
    goal: 'Test whether mini-claude can fetch a specific file from a GitHub repository and display its contents. Example: show the package.json from YuanyangLiNEU/mini-claude.',
    successCriteria: [
      'mini-claude showed the actual contents of package.json',
      'the content includes "mini-claude" as the package name (proving a real read)',
    ],
    maxTurns: 6,
  },

  // ---- GitHub: create issue ----
  {
    name: 'github_create_issue',
    goal: 'Test whether mini-claude can create a real issue on a GitHub repository. Create a test issue on YuanyangLiNEU/mini-claude titled "eval test: MCP GitHub integration" with body "Automated test issue created by mini-claude eval. Safe to close."',
    successCriteria: [
      'an issue was created with the requested title',
      'mini-claude confirmed the creation with an issue number or URL',
    ],
    persona: 'Approve any permission prompts — you want the issue created.',
    maxTurns: 6,
  },

  // ---- GitHub: search and save to file ----
  {
    name: 'github_search_and_save',
    goal: `Test whether mini-claude can combine GitHub lookup with a local file write. Example: fetch the 3 most recent commits on YuanyangLiNEU/mini-claude and save a summary to ${SANDBOX}/commits.txt`,
    successCriteria: [
      'the saved file references real, current commit messages from the repo',
      'mini-claude confirmed both the lookup and the write',
    ],
    persona: 'Approve any permission prompts — you want the summary saved.',
    setup: async () => {
      await ensureSandbox()
      await rmIfExists(`${SANDBOX}/commits.txt`)
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/commits.txt`)
    },
    maxTurns: 8,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Medium tasks — multi-step, real-world utility, hours of work distilled
  // These are "would I actually use this?" tasks that exercise planning
  // and synthesis across multiple tool calls.
  // ═══════════════════════════════════════════════════════════════════════════

  // ---- Medium: Beat-specific news digest ----
  {
    name: 'medium_news_digest',
    goal: `Test whether mini-claude can do multi-source research, synthesize it with editorial judgment, and produce a polished written deliverable. Example task: research top tech stories from the last 24 hours, cluster by theme, and save a 5-minute-read digest to ${SANDBOX}/today.md`,
    successCriteria: [
      'the digest includes at least 3 real news items with concrete details (headlines, companies, or dates)',
      'the digest shows editorial judgment — themed, ranked, or synthesized, not a raw dump',
      'mini-claude confirmed the file was saved',
    ],
    persona: 'Approve any permission prompts — you want the digest saved.',
    setup: async () => {
      await ensureSandbox()
      await rmIfExists(`${SANDBOX}/today.md`)
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/today.md`)
    },
    maxTurns: 12,
  },

  // ---- Medium: Deep dive on one technical topic ----
  {
    name: 'medium_tech_explainer',
    goal: `Test whether mini-claude can produce an in-depth technical explainer that synthesizes information from multiple authoritative sources. Example task: research prompt caching across Anthropic, OpenAI, and Google and save a technical explainer with code examples to ${SANDBOX}/prompt-caching.md`,
    successCriteria: [
      'the explainer covers at least 2 major LLM providers',
      'it includes concrete technical details (cost savings, TTL, API syntax)',
      'it includes at least one code example',
      'mini-claude confirmed the file was saved',
    ],
    persona: 'Approve any permission prompts — you want the explainer saved.',
    setup: async () => {
      await ensureSandbox()
      await rmIfExists(`${SANDBOX}/prompt-caching.md`)
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/prompt-caching.md`)
    },
    maxTurns: 12,
  },

  // ---- Medium: Build a small useful tool ----
  {
    name: 'medium_build_cli_tool',
    goal: `Test whether mini-claude can design and implement a small working CLI tool from a functional description. Example: build a 'standup' tool that reads recent git commits, groups them, and prints a standup-ready summary. Single-file TypeScript runnable with 'bun run standup.ts'. Save to ${SANDBOX}/standup.ts`,
    successCriteria: [
      'the saved file is valid, runnable TypeScript (not pseudocode)',
      'the code actually reads git commits (via subprocess or similar)',
      'the output is formatted as a standup summary',
    ],
    persona: 'Approve any permission prompts — you want a working tool.',
    setup: async () => {
      await ensureSandbox()
      await rmIfExists(`${SANDBOX}/standup.ts`)
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/standup.ts`)
    },
    maxTurns: 10,
  },

  // ---- Medium: Thoughtful gift recommendation ----
  {
    name: 'medium_gift_research',
    goal: `Test whether mini-claude can do constraint-driven research and produce prioritized, personalized recommendations. Example task: recommend 5 ranked birthday gifts for a 65-year-old mom who loves gardening and cooking but hates clutter and has every kitchen gadget, budget $75 each, with reasons and purchase links. Save to ${SANDBOX}/mom-gift.md`,
    successCriteria: [
      'at least 4 distinct specific products are recommended (not vague categories)',
      'each recommendation explains why it fits the constraints',
      'each stays within the budget',
      'recommendations are ranked or prioritized',
    ],
    persona: 'Approve any permission prompts — you want the recommendations saved.',
    setup: async () => {
      await ensureSandbox()
      await rmIfExists(`${SANDBOX}/mom-gift.md`)
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/mom-gift.md`)
    },
    maxTurns: 10,
  },

  // ---- Medium: Personal data analysis + visualization ----
  {
    name: 'medium_data_dashboard',
    goal: `Test whether mini-claude can read a local data file, analyze it, and produce a polished HTML visualization. Example: analyze the log at ${SANDBOX}/activity.log and save a one-page HTML dashboard with charts to ${SANDBOX}/my-stats.html`,
    successCriteria: [
      'the dashboard references real data from the log, not fabricated',
      'it includes at least 2 distinct visualizations',
      'the HTML is valid and would render in a browser',
    ],
    persona: 'Approve any permission prompts — you want the dashboard saved.',
    setup: async () => {
      await ensureSandbox()
      // Create a sample activity log for the agent to analyze
      const log = [
        '2026-04-01 09:15 commit feat(auth): add login endpoint',
        '2026-04-01 11:30 commit fix(api): handle null user case',
        '2026-04-01 14:22 review merged PR #42',
        '2026-04-02 08:45 commit docs: update README',
        '2026-04-02 10:15 commit feat(ui): add dark mode toggle',
        '2026-04-02 16:30 meeting standup with team',
        '2026-04-03 09:00 commit refactor: extract auth middleware',
        '2026-04-03 13:45 commit test: add integration tests',
        '2026-04-03 17:10 review approved PR #45',
        '2026-04-04 10:20 commit fix(ui): dark mode contrast issues',
        '2026-04-04 14:00 meeting design review',
        '2026-04-05 11:30 commit feat(api): rate limiting',
        '2026-04-05 15:45 commit docs: API examples',
        '2026-04-06 09:30 commit fix: rate limit edge case',
        '2026-04-06 12:00 review merged PR #47',
        '2026-04-07 10:15 commit feat(ui): user avatars',
        '2026-04-07 16:20 meeting 1:1 with manager',
      ].join('\n')
      await Bun.write(`${SANDBOX}/activity.log`, log)
      await rmIfExists(`${SANDBOX}/my-stats.html`)
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/activity.log`)
      await rmIfExists(`${SANDBOX}/my-stats.html`)
    },
    maxTurns: 10,
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // HARD tasks — north-star aspirations. These are end-to-end real-world
  // capabilities that would be genuinely impressive if mini-claude could do
  // them. Expect most to fail today; use them to drive the roadmap.
  // ═══════════════════════════════════════════════════════════════════════════

  // ---- Hard: Ship a complete indie game ----
  {
    name: 'hard_ship_indie_game',
    goal: `Test whether mini-claude can design and ship a complete playable game end-to-end. Example: build a 2D browser platformer with 5 levels, jump/dash/attack mechanics, enemies, power-ups, a boss fight, main menu, pause screen, and save/load. Output as multiple files under ${SANDBOX}/game/ — playable by opening index.html.`,
    successCriteria: [
      'multiple files were written (at least index.html and a JS file)',
      'the game has meaningful gameplay mechanics (not a static page)',
      'there is evidence of level design, enemies, and menu/pause states',
      'opening index.html in a browser would produce a playable game',
    ],
    persona: 'Approve any permission prompts — you want the game shipped.',
    setup: async () => {
      await ensureSandbox()
      try { await rm(`${SANDBOX}/game`, { recursive: true, force: true }) } catch {}
    },
    cleanup: async () => {
      try { await rm(`${SANDBOX}/game`, { recursive: true, force: true }) } catch {}
    },
    maxTurns: 20,
  },

  // ---- Hard: Investor-grade equity research ----
  {
    name: 'hard_equity_research',
    goal: `Test whether mini-claude can produce institutional-quality equity research. Example: write a full buy/hold/sell report on NVIDIA including revenue breakdown by segment, competitive moat analysis vs AMD/Intel, DCF model with scenarios, macro risks, and a recommendation. Save to ${SANDBOX}/nvidia-report.md and a companion interactive model to ${SANDBOX}/nvidia-model.html with adjustable assumptions.`,
    successCriteria: [
      'both files were saved',
      'the report includes concrete financial numbers (real revenue, margins, growth rates)',
      'there is a DCF or other quantitative model with multiple scenarios',
      'the analysis covers competitors and macro risks with specifics, not vague generalities',
      'the HTML model is interactive (adjustable inputs affect outputs)',
    ],
    persona: 'Approve any permission prompts — you want the research.',
    setup: async () => {
      await ensureSandbox()
      await rmIfExists(`${SANDBOX}/nvidia-report.md`)
      await rmIfExists(`${SANDBOX}/nvidia-model.html`)
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/nvidia-report.md`)
      await rmIfExists(`${SANDBOX}/nvidia-model.html`)
    },
    maxTurns: 25,
  },

  // ---- Hard: Plan and book a full trip ----
  {
    name: 'hard_book_full_trip',
    goal: `Test whether mini-claude can plan and coordinate the logistics of a real trip end-to-end. Example: plan a 2-week honeymoon to Japan in June for two, budget $15k, focused on traditional culture and Michelin food. Produce a complete itinerary at ${SANDBOX}/japan-trip.md including flights (specific routes and dates), ryokans with room types, restaurant reservations needed, rail pass, pocket wifi, and a daily cost breakdown summing to the total budget.`,
    successCriteria: [
      'the itinerary covers all 14 days with specific activities and locations',
      'flights are specified with real airlines, routes, and approximate prices',
      'accommodations are named (specific ryokans or hotels), not vague categories',
      'the budget is itemized and totals within range of $15k',
      'logistics like rail passes and reservations are explicitly addressed',
    ],
    persona: 'Approve any permission prompts — you want the trip plan saved.',
    setup: async () => {
      await ensureSandbox()
      await rmIfExists(`${SANDBOX}/japan-trip.md`)
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/japan-trip.md`)
    },
    maxTurns: 20,
  },

  // ---- Hard: Year-in-review personal dashboard ----
  {
    name: 'hard_personal_year_in_review',
    goal: `Test whether mini-claude can synthesize multi-source personal data into an insightful year-in-review. Example: read the personal activity data at ${SANDBOX}/personal-data.json (simulated GitHub/calendar/spending data) and build a one-page HTML dashboard at ${SANDBOX}/year-review.html showing accomplishments, time allocation, spending patterns, habit trends, and recommendations for next year.`,
    successCriteria: [
      'the dashboard uses real data from the provided JSON (not fabricated)',
      'it includes at least 4 distinct insights or visualizations',
      'it identifies concrete recommendations for next year based on the data',
      'the HTML is visually polished, not a plain unstyled list',
    ],
    persona: 'Approve any permission prompts — you want the review saved.',
    setup: async () => {
      await ensureSandbox()
      const data = {
        github: {
          total_commits: 482,
          repos_active: 7,
          top_languages: { TypeScript: 310, Python: 120, Rust: 52 },
          busiest_month: 'October',
          quietest_month: 'July',
          most_active_hours: [9, 10, 11, 21, 22],
        },
        calendar: {
          meetings: 396,
          focus_time_hours: 412,
          one_on_ones: 78,
          all_hands: 24,
        },
        spending: {
          total_usd: 42300,
          categories: {
            rent: 18000, groceries: 4200, dining: 3800,
            travel: 5600, subscriptions: 1400, health: 2100,
            coffee: 980, misc: 6220,
          },
        },
        habits: {
          days_exercised: 148,
          days_meditated: 72,
          books_read: 11,
        },
      }
      await Bun.write(`${SANDBOX}/personal-data.json`, JSON.stringify(data, null, 2))
      await rmIfExists(`${SANDBOX}/year-review.html`)
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/personal-data.json`)
      await rmIfExists(`${SANDBOX}/year-review.html`)
    },
    maxTurns: 15,
  },

  // ---- Hard: Write a technical book ----
  {
    name: 'hard_write_technical_book',
    goal: `Test whether mini-claude can produce a book-length technical deliverable with consistent structure and substantive content. Example: write a short technical book titled "Distributed Systems for Staff Engineers" with 5 chapters, each covering a distinct topic with working code examples, ASCII architecture diagrams, and exercises. Save to ${SANDBOX}/book.md`,
    successCriteria: [
      'the file contains 5 distinct chapters with clear structure',
      'each chapter includes at least one working code example',
      'each chapter has at least one architecture diagram (ASCII or Mermaid)',
      'each chapter ends with exercises for the reader',
      'the total length is substantial (>10k characters)',
    ],
    persona: 'Approve any permission prompts — you want the book saved.',
    setup: async () => {
      await ensureSandbox()
      await rmIfExists(`${SANDBOX}/book.md`)
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/book.md`)
    },
    maxTurns: 25,
  },

  // ---- Hard: Personalized 30-day learning program ----
  {
    name: 'hard_learning_curriculum',
    goal: `Test whether mini-claude can design a complete adaptive learning program with daily content and exercises. Example: create a 30-day curriculum teaching Rust to an experienced Java/C++ developer. Each day must have: a topic, learning objectives, a reading, an exercise, and a solution. Capstone project on day 30 should be a production-quality web server. Save to ${SANDBOX}/rust-30-days.md`,
    successCriteria: [
      'the curriculum has 30 distinct days with unique topics',
      'difficulty progresses from basics to advanced (ownership, lifetimes, async, error handling)',
      'each day has concrete exercises, not just readings',
      'the capstone project is well-scoped and builds on earlier days',
      'the curriculum acknowledges the learner\'s Java/C++ background',
    ],
    persona: 'Approve any permission prompts — you want the curriculum saved.',
    setup: async () => {
      await ensureSandbox()
      await rmIfExists(`${SANDBOX}/rust-30-days.md`)
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/rust-30-days.md`)
    },
    maxTurns: 20,
  },

  // ---- Hard: Full startup validation package ----
  {
    name: 'hard_startup_validation',
    goal: `Test whether mini-claude can produce a complete startup validation package: market analysis, competitors, financial model, positioning, and landing page. Example: validate a B2B SaaS idea for bookkeeping automation at small accounting firms. Save all artifacts under ${SANDBOX}/startup/ — market research as market.md, competitor analysis as competitors.md, financial projections as financials.md, a pitch deck outline as pitch.md, and a landing page as landing.html.`,
    successCriteria: [
      'all 5 artifacts were saved under the directory',
      'the market research includes concrete market size numbers and trends',
      'at least 5 real competitors are analyzed with pricing and positioning',
      'the financial model has specific revenue assumptions and a 3-year projection',
      'the landing page is functional HTML with a clear value prop and CTA',
    ],
    persona: 'Approve any permission prompts — you want the validation package saved.',
    setup: async () => {
      await ensureSandbox()
      try { await rm(`${SANDBOX}/startup`, { recursive: true, force: true }) } catch {}
    },
    cleanup: async () => {
      try { await rm(`${SANDBOX}/startup`, { recursive: true, force: true }) } catch {}
    },
    maxTurns: 25,
  },

  // ---- Hard: Execute a complex purchase end-to-end ----
  {
    name: 'hard_complex_purchase_plan',
    goal: `Test whether mini-claude can coordinate a complex multi-stakeholder purchase decision end-to-end. Example: produce a complete buying plan for a used Toyota Sienna, 2022 or newer, under $35k, within 100 miles of San Francisco. Save to ${SANDBOX}/car-buying-plan.md including: specific listings found, CarFax check plan, inspection checklist, dealer negotiation scripts, financing options, and DMV paperwork steps.`,
    successCriteria: [
      'the plan identifies at least 3 real listings with VINs or dealer names',
      'it includes concrete negotiation talking points (not generic "ask for a discount")',
      'it includes an inspection checklist with specific items to check',
      'it covers financing options with real lender names',
      'it outlines the DMV/title transfer steps',
    ],
    persona: 'Approve any permission prompts — you want the plan saved.',
    setup: async () => {
      await ensureSandbox()
      await rmIfExists(`${SANDBOX}/car-buying-plan.md`)
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/car-buying-plan.md`)
    },
    maxTurns: 20,
  },

  // ---- Hard: Publishable academic literature review ----
  {
    name: 'hard_literature_review',
    goal: `Test whether mini-claude can produce academic-grade scholarship: a literature review synthesizing a research field with proper citations. Example: write a comprehensive review of "LLM agents for software engineering" covering 2023-2026. Save to ${SANDBOX}/lit-review.md with proper citations in ACM format. Must cite at least 20 real papers with titles, authors, and venues.`,
    successCriteria: [
      'at least 20 real papers are cited with author, title, and venue',
      'citations are in ACM format',
      'the review has a clear taxonomy of approaches, not just a list of papers',
      'it identifies trends, gaps, or contradictions in the literature',
      'the writing is academic in tone, not a blog post',
    ],
    persona: 'Approve any permission prompts — you want the review saved.',
    setup: async () => {
      await ensureSandbox()
      await rmIfExists(`${SANDBOX}/lit-review.md`)
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/lit-review.md`)
    },
    maxTurns: 25,
  },

  // ---- Hard: Build and ship a revenue-generating SaaS ----
  {
    name: 'hard_build_saas_prototype',
    goal: `Test whether mini-claude can build a working full-stack SaaS prototype end-to-end. Example: build a habit tracker — a single-page web app with Postgres-style schema (SQL file), a backend API (single file), a Next.js-style frontend (single HTML page or React component), Stripe integration scaffold, and a README explaining how to run it. Save under ${SANDBOX}/habit-tracker/ with schema.sql, api.ts, index.html, README.md.`,
    successCriteria: [
      'all 4 files were saved under the directory',
      'the SQL schema defines reasonable tables for users, habits, and check-ins',
      'the API file defines CRUD endpoints that match the schema',
      'the HTML frontend includes a working UI that references the API',
      'the README has clear setup and run instructions',
    ],
    persona: 'Approve any permission prompts — you want the prototype saved.',
    setup: async () => {
      await ensureSandbox()
      try { await rm(`${SANDBOX}/habit-tracker`, { recursive: true, force: true }) } catch {}
    },
    cleanup: async () => {
      try { await rm(`${SANDBOX}/habit-tracker`, { recursive: true, force: true }) } catch {}
    },
    maxTurns: 25,
  },
]
