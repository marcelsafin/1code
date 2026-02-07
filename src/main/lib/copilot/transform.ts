/**
 * Transform Copilot SDK events to 1Code UIMessageChunk format
 * 
 * Maps events from @github/copilot-sdk to the same chunk format
 * used by the Claude integration, allowing the UI to work unchanged.
 */

import type { UIMessageChunk, MessageMetadata } from "./types"

export interface TransformerOptions {
  /** Include SDK message UUIDs for session resumption */
  emitSdkMessageUuid?: boolean
}

export function createCopilotTransformer(options?: TransformerOptions) {
  let textId: string | null = null
  let textStarted = false
  let started = false
  let startTime: number | null = null

  // Track streaming tool calls
  let currentToolCallId: string | null = null
  let currentToolName: string | null = null

  // Track accumulated text for final message
  let accumulatedText = ""

  const genId = () => `text-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

  // Helper to end current text block
  function* endTextBlock(): Generator<UIMessageChunk> {
    if (textStarted && textId) {
      yield { type: "text-end", id: textId }
      textStarted = false
      textId = null
    }
  }

  /**
   * Transform a Copilot SDK event to UIMessageChunk(s)
   * 
   * Copilot SDK events:
   * - assistant.message_delta: { deltaContent: string }
   * - assistant.message: { content: string }
   * - assistant.reasoning_delta: { deltaContent: string }
   * - assistant.reasoning: { content: string }
   * - tool.execution_start: { toolName: string, toolCallId: string, input: unknown }
   * - tool.execution_complete: { toolCallId: string, result: unknown, error?: string }
   * - session.idle: {}
   * - error: { message: string, code?: string }
   */
  return function* transform(eventType: string, eventData: any): Generator<UIMessageChunk> {
    // Emit start once
    if (!started) {
      started = true
      startTime = Date.now()
      yield { type: "start" }
      yield { type: "start-step" }
    }

    switch (eventType) {
      // ===== TEXT STREAMING =====
      case "assistant.message_delta": {
        if (!textStarted) {
          textId = genId()
          yield { type: "text-start", id: textId }
          textStarted = true
        }
        const delta = eventData?.deltaContent || ""
        accumulatedText += delta
        yield { type: "text-delta", id: textId!, delta }
        break
      }

      case "assistant.message": {
        // Final message - if we were streaming, just end the block
        // If not streaming, emit the full content
        if (textStarted) {
          yield* endTextBlock()
        } else if (eventData?.content) {
          textId = genId()
          yield { type: "text-start", id: textId }
          yield { type: "text-delta", id: textId, delta: eventData.content }
          yield { type: "text-end", id: textId }
          accumulatedText = eventData.content
        }
        break
      }

      // ===== REASONING/THINKING =====
      case "assistant.reasoning_delta": {
        // Emit reasoning as a "Thinking" tool for UI consistency
        if (!currentToolCallId || currentToolName !== "Thinking") {
          currentToolCallId = `thinking-${Date.now()}`
          currentToolName = "Thinking"
          yield {
            type: "tool-input-start",
            toolCallId: currentToolCallId,
            toolName: "Thinking",
          }
        }
        const delta = eventData?.deltaContent || ""
        // Emit as JSON fragment for AI SDK parsing
        const escaped = JSON.stringify(delta).slice(1, -1)
        yield {
          type: "tool-input-delta",
          toolCallId: currentToolCallId,
          inputTextDelta: escaped,
        }
        break
      }

      case "assistant.reasoning": {
        // Final reasoning block
        if (currentToolName === "Thinking" && currentToolCallId) {
          yield {
            type: "tool-input-available",
            toolCallId: currentToolCallId,
            toolName: "Thinking",
            input: { text: eventData?.content || "" },
          }
          yield {
            type: "tool-output-available",
            toolCallId: currentToolCallId,
            output: { completed: true },
          }
          currentToolCallId = null
          currentToolName = null
        }
        break
      }

      // ===== TOOL EXECUTION =====
      case "tool.execution_start": {
        yield* endTextBlock()
        
        currentToolCallId = eventData?.toolCallId || genId()
        currentToolName = eventData?.toolName || "unknown"

        yield {
          type: "tool-input-start",
          toolCallId: currentToolCallId,
          toolName: currentToolName,
        }
        yield {
          type: "tool-input-available",
          toolCallId: currentToolCallId,
          toolName: currentToolName,
          input: eventData?.input || {},
          providerMetadata: { custom: { startedAt: Date.now() } },
        }
        break
      }

      case "tool.execution_complete": {
        const toolCallId = eventData?.toolCallId || currentToolCallId

        if (eventData?.error) {
          yield {
            type: "tool-output-error",
            toolCallId: toolCallId!,
            errorText: eventData.error,
          }
        } else {
          yield {
            type: "tool-output-available",
            toolCallId: toolCallId!,
            output: eventData?.result || {},
          }
        }

        if (currentToolCallId === toolCallId) {
          currentToolCallId = null
          currentToolName = null
        }
        break
      }

      // ===== SESSION EVENTS =====
      case "session.idle": {
        yield* endTextBlock()

        const metadata: MessageMetadata = {
          durationMs: startTime ? Date.now() - startTime : undefined,
          resultSubtype: "success",
        }

        yield { type: "message-metadata", messageMetadata: metadata }
        yield { type: "finish-step" }
        yield { type: "finish", messageMetadata: metadata }
        break
      }

      // ===== ERRORS =====
      case "error": {
        const errorMessage = eventData?.message || "Unknown error"
        const errorCode = eventData?.code

        // Check for auth errors
        if (errorCode === "AUTH_REQUIRED" || errorMessage.includes("authentication")) {
          yield { type: "auth-error", message: errorMessage }
        } else {
          yield {
            type: "error",
            errorText: errorMessage,
            debugInfo: { code: errorCode },
          }
        }
        break
      }
    }
  }
}
