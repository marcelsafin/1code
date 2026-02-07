/**
 * Copilot tRPC Router
 * 
 * Minimal implementation that replaces claude.ts for GitHub Copilot SDK integration.
 * Starts with basic chat, will expand to include tools/MCP later.
 */

import { observable } from "@trpc/server/observable"
import { eq } from "drizzle-orm"
import { app } from "electron"
import * as fs from "fs/promises"
import path from "path"
import { z } from "zod"
import { createCopilotTransformer } from "../../copilot/transform"
import type { UIMessageChunk } from "../../copilot/types"
import { getDatabase, subChats } from "../../db"
import { publicProcedure, router } from "../index"

// Dynamic import for ESM module
let CopilotClientClass: any = null
let clientInstance: any = null

async function getCopilotClient() {
  if (clientInstance) return clientInstance
  
  if (!CopilotClientClass) {
    const sdk = await import("@github/copilot-sdk")
    CopilotClientClass = sdk.CopilotClient
  }
  
  clientInstance = new CopilotClientClass({
    useLoggedInUser: true, // Use credentials from `copilot` CLI login
  })
  
  await clientInstance.start()
  return clientInstance
}

// Active sessions for cancellation
const activeSessions = new Map<string, {
  session: any
  abortController: AbortController
}>()

// Image attachment schema
const imageAttachmentSchema = z.object({
  base64Data: z.string(),
  mediaType: z.string(),
  filename: z.string().optional(),
})

export const copilotRouter = router({
  /**
   * Check if Copilot SDK is authenticated
   */
  isAuthenticated: publicProcedure.query(async () => {
    try {
      const client = await getCopilotClient()
      await client.ping()
      return { authenticated: true, error: null }
    } catch (error) {
      return { 
        authenticated: false, 
        error: error instanceof Error ? error.message : "Authentication failed" 
      }
    }
  }),

  /**
   * List available models
   */
  listModels: publicProcedure.query(async () => {
    // TODO: Use client.listModels() when available
    return [
      { id: "gpt-4.1", name: "GPT-4.1", provider: "openai" },
      { id: "gpt-5", name: "GPT-5", provider: "openai" },
      { id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic" },
      { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", provider: "anthropic" },
      { id: "claude-opus-4", name: "Claude Opus 4", provider: "anthropic" },
    ]
  }),

  /**
   * Send a message and stream response
   */
  chat: publicProcedure
    .input(
      z.object({
        chatId: z.string(),
        subChatId: z.string(),
        prompt: z.string(),
        cwd: z.string(),
        projectPath: z.string().optional(),
        model: z.string().optional().default("claude-sonnet-4"),
        images: z.array(imageAttachmentSchema).optional(),
        sessionId: z.string().optional(),
        reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
      })
    )
    .subscription(async ({ input }) => {
      return observable<UIMessageChunk>((emit) => {
        const streamId = crypto.randomUUID()
        let isActive = true

        const safeEmit = (chunk: UIMessageChunk) => {
          if (!isActive) return false
          try {
            emit.next(chunk)
            return true
          } catch {
            isActive = false
            return false
          }
        }

        const safeComplete = () => {
          try {
            emit.complete()
          } catch {
            // Already completed
          }
        }

        ;(async () => {
          try {
            const db = getDatabase()

            // Get existing messages
            const existing = db
              .select()
              .from(subChats)
              .where(eq(subChats.id, input.subChatId))
              .get()
            const existingMessages = JSON.parse(existing?.messages || "[]")

            // Create user message
            const userMessage = {
              id: crypto.randomUUID(),
              role: "user",
              parts: [{ type: "text", text: input.prompt }],
            }

            // Save user message to DB
            const messagesToSave = [...existingMessages, userMessage]
            db.update(subChats)
              .set({
                messages: JSON.stringify(messagesToSave),
                streamId,
                updatedAt: new Date(),
              })
              .where(eq(subChats.id, input.subChatId))
              .run()

            // Get or create Copilot client
            const client = await getCopilotClient()

            // Create session
            const session = await client.createSession({
              model: input.model,
              streaming: true,
              reasoningEffort: input.reasoningEffort,
            })

            // Store for cancellation
            const abortController = new AbortController()
            activeSessions.set(input.subChatId, { session, abortController })

            // Setup transformer
            const transform = createCopilotTransformer()

            // Subscribe to events
            const unsubscribe = session.on((event: any) => {
              if (!isActive) return

              // Transform and emit chunks
              for (const chunk of transform(event.type, event.data)) {
                safeEmit(chunk)
              }
            })

            // Send message
            try {
              await session.send({ prompt: input.prompt })
            } catch (error) {
              console.error("[copilot] Send error:", error)
              safeEmit({
                type: "error",
                errorText: error instanceof Error ? error.message : "Send failed",
              })
            }

            // Wait for session.idle
            await new Promise<void>((resolve) => {
              const idleHandler = session.on("session.idle", () => {
                resolve()
              })
              
              // Timeout after 5 minutes
              setTimeout(() => {
                resolve()
              }, 5 * 60 * 1000)
            })

            // Cleanup
            unsubscribe()
            await session.destroy()
            activeSessions.delete(input.subChatId)

            // Save assistant response to DB
            // Note: We'd need to accumulate text from transform to save properly
            // For now, this is simplified

            safeComplete()

          } catch (error) {
            console.error("[copilot] Chat error:", error)
            safeEmit({
              type: "error",
              errorText: error instanceof Error ? error.message : "Unknown error",
            })
            safeComplete()
          }
        })()

        // Return cleanup function
        return () => {
          isActive = false
          const activeSession = activeSessions.get(input.subChatId)
          if (activeSession) {
            activeSession.session.abort?.()
            activeSessions.delete(input.subChatId)
          }
        }
      })
    }),

  /**
   * Abort a running chat
   */
  abort: publicProcedure
    .input(z.object({ subChatId: z.string() }))
    .mutation(async ({ input }) => {
      const activeSession = activeSessions.get(input.subChatId)
      if (activeSession) {
        await activeSession.session.abort?.()
        activeSessions.delete(input.subChatId)
        return { success: true }
      }
      return { success: false, error: "No active session" }
    }),

  /**
   * Shutdown client (for app cleanup)
   */
  shutdown: publicProcedure.mutation(async () => {
    if (clientInstance) {
      // Destroy all sessions
      for (const [id, { session }] of activeSessions) {
        try {
          await session.destroy()
        } catch {}
      }
      activeSessions.clear()

      // Stop client
      try {
        await clientInstance.stop()
      } catch {}
      clientInstance = null
    }
    return { success: true }
  }),
})

export type CopilotRouter = typeof copilotRouter
