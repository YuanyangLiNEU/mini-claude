/**
 * Task and conversation types for the mini-claude eval harness.
 *
 * Evaluation is conversation-driven: a simulated user (the "evaluator",
 * backed by an LLM) exchanges messages with mini-claude until its goal
 * is met, it gives up, or a turn cap is hit. You see the evaluator's
 * thinking at each step.
 */

export type Task = {
  /** Short identifier */
  name: string
  /**
   * What the simulated user wants to accomplish. The evaluator's system
   * prompt is built around this goal — it drives the opening message and
   * all subsequent decisions.
   */
  goal: string
  /**
   * Concrete success criteria the evaluator checks each turn. When the
   * evaluator judges these all met, it emits 'goal_met'.
   */
  successCriteria: string[]
  /** The first message the simulated user sends to mini-claude. */
  openingMessage: string
  /**
   * Persona guidance for the evaluator (optional). E.g. "You are a careful
   * user who denies any write to paths containing 'blocked'."
   */
  persona?: string
  /**
   * How many conversation turns the evaluator is allowed. One turn =
   * one mini-claude response + one evaluator decision. Default 6.
   */
  maxTurns?: number
  /**
   * Human-readable description of what setup() does. Shown in the runner
   * output and portal so it's clear what state the sandbox is in before
   * the conversation starts.
   */
  setupDescription?: string
  /** Optional setup run before the conversation starts */
  setup?: () => Promise<void>
  /** Optional cleanup run after the conversation ends */
  cleanup?: () => Promise<void>
}

/**
 * What the evaluator decides at each turn. 'goal_met' / 'give_up' end the
 * conversation; 'send_message' continues it; 'approve'/'deny' respond to
 * a permission prompt.
 */
export type EvaluatorDecision =
  | { action: 'goal_met'; thinking: string; summary: string }
  | { action: 'give_up'; thinking: string; reason: string }
  | { action: 'send_message'; thinking: string; message: string }
  | { action: 'approve_permission'; thinking: string }
  | { action: 'deny_permission'; thinking: string; why: string }

/** One complete turn in the conversation — what mini-claude did + evaluator's reaction. */
export type TurnRecord = {
  turnNum: number
  /** Messages mini-claude produced during its agent loop (text + tool calls). */
  miniClaudeActions: MiniClaudeAction[]
  /** Metrics from mini-claude's agent loop this turn. */
  metrics: {
    turns: number // mini-claude's internal turns (tool-use loops)
    inputTokens: number
    outputTokens: number
    wallMs: number
  }
  /** The evaluator's decision at the end of this turn. */
  evaluatorDecision: EvaluatorDecision
  /** If the agent asked for permission mid-turn, this records it. */
  permissionEvent?: {
    toolName: string
    toolInput: unknown
    decision: 'approve' | 'deny'
    evaluatorThinking: string
    evaluatorWhy?: string
  }
}

export type MiniClaudeAction =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; result: string; isError: boolean }

/** Result of running one conversation to completion. */
export type ConversationResult = {
  task: Task
  turns: TurnRecord[]
  outcome: 'goal_met' | 'give_up' | 'max_turns' | 'error'
  finalSummary?: string
  giveUpReason?: string
  errorMessage?: string
  totalWallMs: number
  totalMiniClaudeInputTokens: number
  totalMiniClaudeOutputTokens: number
}
