/**
 * Type definitions for Copilot SDK integration
 */

// UI Message Chunk types (same as Claude integration for compatibility)
export type UIMessageChunk =
  | { type: "start" }
  | { type: "start-step" }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "tool-input-start"; toolCallId: string; toolName: string }
  | { type: "tool-input-delta"; toolCallId: string; inputTextDelta: string }
  | { type: "tool-input-available"; toolCallId: string; toolName: string; input: unknown; providerMetadata?: unknown }
  | { type: "tool-output-available"; toolCallId: string; output: unknown }
  | { type: "tool-output-error"; toolCallId: string; errorText: string }
  | { type: "session-init"; tools: string[]; mcpServers: MCPServer[]; plugins: string[]; skills: string[] }
  | { type: "message-metadata"; messageMetadata: MessageMetadata }
  | { type: "finish-step" }
  | { type: "finish"; messageMetadata?: MessageMetadata }
  | { type: "error"; errorText: string; debugInfo?: unknown }
  | { type: "auth-error"; message: string }
  | { type: "retry-notification"; message: string }

export interface MCPServer {
  name: string
  status: MCPServerStatus
  serverInfo?: {
    name: string
    version: string
    icons?: Array<{ src: string; mimeType?: string; sizes?: string[]; theme?: "light" | "dark" }>
  }
  error?: string
}

export type MCPServerStatus = "connected" | "failed" | "pending" | "needs-auth"

export interface MessageMetadata {
  sessionId?: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  totalCostUsd?: number
  durationMs?: number
  resultSubtype?: string
  finalTextId?: string
  modelUsage?: Record<string, {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens?: number
    cacheCreationInputTokens?: number
    costUSD?: number
  }>
}

// Copilot-specific configuration
export interface CopilotConfig {
  /** GitHub token for authentication (optional if using CLI login) */
  githubToken?: string
  /** Use credentials from logged-in CLI user */
  useLoggedInUser?: boolean
  /** Path to Copilot CLI executable */
  cliPath?: string
}

export interface CopilotSessionConfig {
  /** Model to use (e.g., "gpt-4.1", "claude-sonnet-4") */
  model: string
  /** Enable streaming responses */
  streaming?: boolean
  /** Custom tools */
  tools?: CopilotTool[]
  /** System message */
  systemMessage?: string
  /** Working directory */
  cwd?: string
  /** Reasoning effort (for supported models) */
  reasoningEffort?: "low" | "medium" | "high" | "xhigh"
}

export interface CopilotTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  handler: (input: unknown) => Promise<unknown>
}

// Copilot SDK event types (from @github/copilot-sdk)
export interface CopilotSessionEvent {
  type: CopilotEventType
  data?: unknown
}

export type CopilotEventType =
  | "assistant.message"
  | "assistant.message_delta"
  | "assistant.reasoning"
  | "assistant.reasoning_delta"
  | "tool.execution_start"
  | "tool.execution_complete"
  | "session.idle"
  | "user.message"
  | "error"

// Available models via Copilot Pro+
export const COPILOT_MODELS = [
  { id: "gpt-4.1", name: "GPT-4.1", provider: "openai" },
  { id: "gpt-5", name: "GPT-5", provider: "openai" },
  { id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic" },
  { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", provider: "anthropic" },
  { id: "claude-opus-4", name: "Claude Opus 4", provider: "anthropic" },
] as const

export type CopilotModelId = typeof COPILOT_MODELS[number]["id"]
