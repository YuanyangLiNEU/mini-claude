/**
 * Conversation history — a mutable list of messages that grows as the user
 * and assistant exchange turns.
 *
 * Reference: claude-code src/QueryEngine.ts (their `mutableMessages`), much simpler.
 */

import type { Message } from './claude.ts'

export class History {
  private messages: Message[] = []

  addUser(content: string): void {
    this.messages.push({ role: 'user', content })
  }

  addAssistant(content: string): void {
    this.messages.push({ role: 'assistant', content })
  }

  all(): Message[] {
    return this.messages
  }

  clear(): void {
    this.messages = []
  }

  get length(): number {
    return this.messages.length
  }
}
