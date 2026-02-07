/**
 * Copilot Agent Manager
 * 
 * Manages CopilotClient and CopilotSession instances, handling:
 * - Client lifecycle (start/stop)
 * - Session creation and management
 * - Event subscription and forwarding
 * - Authentication
 */

import type { CopilotConfig, CopilotSessionConfig, UIMessageChunk } from "./types"
import { createCopilotTransformer } from "./transform"

// We'll import CopilotClient dynamically to handle ESM module loading
let CopilotClientClass: any = null

async function getCopilotClient() {
  if (!CopilotClientClass) {
    const sdk = await import("@github/copilot-sdk")
    CopilotClientClass = sdk.CopilotClient
  }
  return CopilotClientClass
}

export class CopilotAgentManager {
  private client: any = null
  private sessions: Map<string, any> = new Map()
  private config: CopilotConfig

  constructor(config: CopilotConfig = {}) {
    this.config = config
  }

  /**
   * Start the Copilot client
   */
  async start(): Promise<void> {
    if (this.client) return

    const CopilotClient = await getCopilotClient()
    
    this.client = new CopilotClient({
      githubToken: this.config.githubToken,
      useLoggedInUser: this.config.useLoggedInUser ?? true,
      cliPath: this.config.cliPath,
    })

    await this.client.start()
  }

  /**
   * Stop the Copilot client and cleanup all sessions
   */
  async stop(): Promise<void> {
    // Destroy all sessions
    for (const [sessionId, session] of this.sessions) {
      try {
        await session.destroy()
      } catch (e) {
        console.error(`[copilot] Failed to destroy session ${sessionId}:`, e)
      }
    }
    this.sessions.clear()

    // Stop client
    if (this.client) {
      try {
        await this.client.stop()
      } catch (e) {
        console.error("[copilot] Failed to stop client:", e)
      }
      this.client = null
    }
  }

  /**
   * Create a new chat session
   */
  async createSession(sessionId: string, config: CopilotSessionConfig): Promise<void> {
    if (!this.client) {
      await this.start()
    }

    const session = await this.client.createSession({
      model: config.model,
      streaming: config.streaming ?? true,
      tools: config.tools,
      systemMessage: config.systemMessage ? { content: config.systemMessage } : undefined,
      reasoningEffort: config.reasoningEffort,
    })

    this.sessions.set(sessionId, session)
  }

  /**
   * Send a message and stream response chunks
   */
  async *chat(
    sessionId: string,
    prompt: string,
    options: {
      abortSignal?: AbortSignal
      images?: Array<{ base64Data: string; mediaType: string }>
    } = {}
  ): AsyncGenerator<UIMessageChunk> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }

    const transformer = createCopilotTransformer()
    const eventQueue: Array<{ type: string; data: any }> = []
    let resolveNext: (() => void) | null = null
    let done = false
    let error: Error | null = null

    // Subscribe to all session events
    const unsubscribe = session.on((event: any) => {
      eventQueue.push({ type: event.type, data: event.data })
      resolveNext?.()
    })

    // Handle abort
    options.abortSignal?.addEventListener("abort", () => {
      session.abort()
      done = true
      resolveNext?.()
    })

    try {
      // Build attachments if images provided
      const attachments = options.images?.map((img, i) => ({
        type: "file",
        path: `image-${i}.${img.mediaType.split("/")[1] || "png"}`,
        // Note: Copilot SDK may need actual file paths, not base64
        // This may need adjustment based on SDK capabilities
      }))

      // Send message (non-blocking)
      session.send({
        prompt,
        ...(attachments && { attachments }),
      }).catch((e: Error) => {
        error = e
        done = true
        resolveNext?.()
      })

      // Process events as they arrive
      while (!done) {
        // Wait for events if queue is empty
        if (eventQueue.length === 0) {
          await new Promise<void>(resolve => {
            resolveNext = resolve
          })
          resolveNext = null
        }

        // Process all queued events
        while (eventQueue.length > 0) {
          const event = eventQueue.shift()!
          
          // Transform and yield chunks
          for (const chunk of transformer(event.type, event.data)) {
            yield chunk

            // Check if this is a terminal event
            if (chunk.type === "finish" || chunk.type === "error" || chunk.type === "auth-error") {
              done = true
            }
          }
        }
      }

      if (error) {
        for (const chunk of transformer("error", { message: error.message })) {
          yield chunk
        }
      }
    } finally {
      unsubscribe()
    }
  }

  /**
   * Abort a running session
   */
  async abort(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) {
      await session.abort()
    }
  }

  /**
   * Destroy a session
   */
  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) {
      await session.destroy()
      this.sessions.delete(sessionId)
    }
  }

  /**
   * List available models
   */
  async listModels(): Promise<Array<{ id: string; name: string }>> {
    if (!this.client) {
      await this.start()
    }

    // TODO: Use client.listModels() when available
    // For now, return hardcoded list
    return [
      { id: "gpt-4.1", name: "GPT-4.1" },
      { id: "gpt-5", name: "GPT-5" },
      { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
      { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
      { id: "claude-opus-4", name: "Claude Opus 4" },
    ]
  }

  /**
   * Check if authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    if (!this.client) {
      try {
        await this.start()
        return true
      } catch {
        return false
      }
    }
    return true
  }

  /**
   * Ping to check connectivity
   */
  async ping(): Promise<boolean> {
    if (!this.client) return false
    try {
      await this.client.ping()
      return true
    } catch {
      return false
    }
  }
}

// Singleton instance
let defaultManager: CopilotAgentManager | null = null

export function getDefaultCopilotManager(): CopilotAgentManager {
  if (!defaultManager) {
    defaultManager = new CopilotAgentManager()
  }
  return defaultManager
}

export async function shutdownCopilotManager(): Promise<void> {
  if (defaultManager) {
    await defaultManager.stop()
    defaultManager = null
  }
}
