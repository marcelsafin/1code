/**
 * Copilot SDK Integration Layer
 * 
 * This module adapts the GitHub Copilot SDK to work with 1Code's existing
 * message/event system. It replaces the Claude SDK integration.
 */

export { createCopilotTransformer } from "./transform"
export { CopilotAgentManager } from "./agent-manager"
export type { CopilotConfig, CopilotSessionConfig } from "./types"
