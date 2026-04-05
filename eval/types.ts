/**
 * Task types for the mini-claude eval harness.
 *
 * Evaluation is judge-driven: each task declares the user's goal and a list
 * of harness expectations, and an LLM judge verifies whether they were met.
 */

export type Task = {
  /** Short identifier, used for output grouping */
  name: string
  /** Prompt the user types to the agent */
  prompt: string
  /**
   * What the user actually wants accomplished. The judge compares the
   * agent's actions against this goal.
   */
  goal: string
  /**
   * Harness expectations the judge looks for. Each one describes a concrete
   * behavior the agent should exhibit. The judge marks each met/missed.
   */
  expectations: string[]
  /** Optional setup run before the agent starts (e.g. create a fixture file) */
  setup?: () => Promise<void>
  /** Optional cleanup run after the task finishes */
  cleanup?: () => Promise<void>
}

export type ToolCallRecord = { name: string; input: unknown }

/** Metrics captured from one agent run. */
export type RunMetrics = {
  turns: number
  inputTokens: number
  outputTokens: number
  wallMs: number
  stoppedWith: string // stop_reason of final turn
}

/** Result of running one task (before the judge is applied). */
export type TaskResult = {
  task: Task
  metrics: RunMetrics
  finalText: string
  toolCalls: ToolCallRecord[]
  error?: string
}
