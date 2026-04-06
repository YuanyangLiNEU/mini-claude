/**
 * Task and conversation types for the mini-claude eval harness.
 *
 * The eval treats mini-claude as a black box (subprocess). Types here
 * describe the evaluator's view: tasks, turn records, decisions.
 * NO imports from mini-claude internals.
 */

export type Task = {
  /** Short identifier */
  name: string
  /** What the simulated user wants to accomplish */
  goal: string
  /** Concrete success criteria the evaluator checks */
  successCriteria: string[]
  /** The first message the simulated user sends */
  openingMessage: string
  /** Persona guidance for the evaluator (optional) */
  persona?: string
  /** Max conversation turns. Default 6. */
  maxTurns?: number
  /** Human-readable description of what setup() does */
  setupDescription?: string
  /** Optional setup run before the conversation starts */
  setup?: () => Promise<void>
  /** Optional cleanup run after the conversation ends */
  cleanup?: () => Promise<void>
}

/** A permission decision made by the evaluator. */
export type PermissionRecord = {
  action: 'approve' | 'deny'
  thinking: string
  why?: string
}

/** An evaluator decision at the end of a turn. */
export type EvaluatorDecisionRecord = {
  action: 'goal_met' | 'give_up' | 'send_message'
  thinking: string
  summary?: string
  reason?: string
  message?: string
}

/** One turn in the conversation. */
export type TurnRecord = {
  turnNum: number | string
  /** Raw stdout captured from mini-claude this turn. */
  rawOutput: string
  /** Why the subprocess stopped reading (prompt/permission/timeout). */
  idleReason: string
  /** If the REPL asked for permission this turn. */
  permissionDecision?: PermissionRecord
  /** The evaluator's decision at the end of this turn. */
  evaluatorDecision?: EvaluatorDecisionRecord
}

/** Result of running one conversation to completion. */
export type ConversationResult = {
  task: Task
  turns: TurnRecord[]
  /** Full raw transcript of everything mini-claude printed. */
  conversationLog: string
  outcome: 'goal_met' | 'give_up' | 'max_turns' | 'error'
  finalSummary?: string
  giveUpReason?: string
  errorMessage?: string
  totalWallMs: number
}
