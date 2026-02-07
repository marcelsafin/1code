# 1Code → GitHub Copilot SDK Migration Plan

**Goal:** Fork 1Code and replace `@anthropic-ai/claude-agent-sdk` with `@github/copilot-sdk` to leverage GitHub Copilot Pro+ subscription for multi-model access (Claude, GPT-4, etc).

**Original repo:** https://github.com/21st-dev/1Code
**Fork:** https://github.com/marcelsafin/1code
**Local:** `/Users/openclaw/.openclaw/workspace/1code-copilot`

---

## 1. Architecture Overview

### Current (1Code + Claude SDK)
```
┌─────────────────────────────────────────────────────────┐
│                    Electron App                          │
├─────────────────────────────────────────────────────────┤
│  Renderer (React)                                        │
│  ├── IPCChatTransport (ipc-chat-transport.ts)           │
│  │   └── Converts UI messages → tRPC subscription       │
│  └── UI Components (chat, sidebar, settings)            │
├─────────────────────────────────────────────────────────┤
│  Main Process                                            │
│  ├── tRPC Router (claude.ts) ← MAIN CHANGE AREA        │
│  │   └── @anthropic-ai/claude-agent-sdk                 │
│  ├── Auth (claude-token.ts, auth-manager.ts)            │
│  └── MCP, Tools, Settings                               │
└─────────────────────────────────────────────────────────┘
           ↓ JSON-RPC (stdio)
┌─────────────────────────────────────────────────────────┐
│  Claude Code CLI (bundled binary)                       │
└─────────────────────────────────────────────────────────┘
```

### Target (1Code + Copilot SDK)
```
┌─────────────────────────────────────────────────────────┐
│                    Electron App                          │
├─────────────────────────────────────────────────────────┤
│  Renderer (React)                                        │
│  ├── IPCChatTransport (mostly unchanged)                │
│  └── UI Components + Model Selector                     │
├─────────────────────────────────────────────────────────┤
│  Main Process                                            │
│  ├── tRPC Router (copilot.ts) ← NEW                     │
│  │   └── @github/copilot-sdk                            │
│  ├── Auth (github-auth.ts) ← NEW                        │
│  │   └── GitHub OAuth / gh auth token                   │
│  └── MCP, Tools, Settings (adapted)                     │
└─────────────────────────────────────────────────────────┘
           ↓ JSON-RPC (stdio)
┌─────────────────────────────────────────────────────────┐
│  Copilot CLI (npm install @github/copilot)              │
└─────────────────────────────────────────────────────────┘
```

---

## 2. SDK API Comparison

### Claude SDK (`@anthropic-ai/claude-agent-sdk`)
```typescript
import { query } from "@anthropic-ai/claude-agent-sdk"

const stream = query({
  prompt: "Hello",
  cwd: "/project",
  options: {
    model: "claude-sonnet-4",
    mcpServers: { ... },
    agents: { ... },
  },
  env: { CLAUDE_CODE_OAUTH_TOKEN: "..." },
  executablePath: "/path/to/claude",
  abortSignal: controller.signal,
  sessionId: "xxx",
  resumeSession: "continue",
})

for await (const message of stream) {
  // message.type: "assistant", "tool_use", "tool_result", etc.
}
```

### Copilot SDK (`@github/copilot-sdk`)
```typescript
import { CopilotClient } from "@github/copilot-sdk"

const client = new CopilotClient({
  githubToken: "gho_xxx",  // or auto from CLI login
})

const session = await client.createSession({
  model: "claude-sonnet-4",  // or "gpt-4.1", etc.
  streaming: true,
  tools: [ ... ],
  systemMessage: { content: "..." },
})

session.on("assistant.message_delta", (event) => {
  // event.data.deltaContent
})

session.on("tool.execution_start", (event) => {
  // event.data.toolName, event.data.input
})

await session.send({ prompt: "Hello" })
await session.destroy()
await client.stop()
```

### Key Differences

| Feature | Claude SDK | Copilot SDK |
|---------|-----------|-------------|
| **Streaming** | AsyncIterator | Event emitter |
| **Session** | sessionId string | CopilotSession object |
| **Auth** | CLAUDE_CODE_OAUTH_TOKEN env | githubToken option or CLI login |
| **Tools** | mcpServers object | tools array with defineTool() |
| **Models** | model option | model option (same) |
| **Binary** | Bundled claude binary | Copilot CLI from npm |

---

## 3. Files to Modify

### High Priority (Core Agent Logic)

| File | Changes | Effort |
|------|---------|--------|
| `src/main/lib/trpc/routers/claude.ts` | Rewrite to use Copilot SDK | HIGH |
| `src/main/lib/claude/transform.ts` | Adapt message transformation | MEDIUM |
| `src/main/lib/claude/types.ts` | Update type definitions | MEDIUM |
| `src/main/lib/claude/env.ts` | Remove Claude-specific env | LOW |
| `package.json` | Replace dependencies | LOW |

### Medium Priority (Auth & Config)

| File | Changes | Effort |
|------|---------|--------|
| `src/main/lib/claude-token.ts` | Replace with GitHub token | MEDIUM |
| `src/main/auth-manager.ts` | GitHub OAuth flow | MEDIUM |
| `src/main/lib/trpc/routers/anthropic-accounts.ts` | Rename/repurpose | LOW |

### Low Priority (UI)

| File | Changes | Effort |
|------|---------|--------|
| `src/renderer/features/agents/lib/ipc-chat-transport.ts` | Minor event mapping | LOW |
| Model selector component | Add model dropdown | LOW |
| Settings | GitHub login UI | LOW |

---

## 4. Message Type Mapping

### Claude SDK Events → UI Chunks
Current transform.ts maps Claude SDK messages to UIMessageChunk:

```typescript
// Claude SDK
{ type: "assistant", message: { content: "..." } }
{ type: "tool_use", tool_use: { name: "...", input: {...} } }
{ type: "tool_result", tool_result: { content: "..." } }

// UIMessageChunk (1Code internal)
{ type: "text-start" }
{ type: "text-delta", text: "..." }
{ type: "text-end" }
{ type: "tool-input-start", toolName: "..." }
{ type: "tool-input-available", input: {...} }
{ type: "tool-output-available", output: "..." }
```

### Copilot SDK Events → UI Chunks
Need to map:

```typescript
// Copilot SDK events
"assistant.message_delta" → { type: "text-delta", text: event.data.deltaContent }
"assistant.message"       → { type: "text-end" }
"tool.execution_start"    → { type: "tool-input-start", toolName: event.data.toolName }
"tool.execution_complete" → { type: "tool-output-available", output: event.data.result }
"session.idle"            → { type: "finish" }
```

---

## 5. Authentication Strategy

### Option A: Use Copilot CLI Login (Recommended)
```bash
# User runs once:
copilot  # Opens GitHub OAuth in browser
```

SDK auto-detects credentials:
```typescript
const client = new CopilotClient()  // Uses stored credentials
```

### Option B: Pass GitHub Token
```typescript
// From gh auth token or OAuth flow
const token = await exec("gh auth token")
const client = new CopilotClient({ githubToken: token.trim() })
```

### Option C: Environment Variable
```bash
export COPILOT_GITHUB_TOKEN="gho_xxx"
```

**Recommendation:** Start with Option A (CLI login), add Option B for advanced users.

---

## 6. Model Selection

### Available Models (Copilot Pro+)
```typescript
const AVAILABLE_MODELS = [
  { id: "gpt-4.1", name: "GPT-4.1" },
  { id: "gpt-5", name: "GPT-5" },
  { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
  { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
  // More via client.listModels()
]
```

### UI Addition
Add dropdown in chat header or settings to select model per session.

---

## 7. MCP (Model Context Protocol) Support

Copilot SDK supports custom tools but NOT MCP directly. Options:

### Option A: Convert MCP → Copilot Tools
```typescript
// MCP server config
{ "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] } }

// Convert to Copilot tool
defineTool("github_search", {
  description: "Search GitHub",
  parameters: z.object({ query: z.string() }),
  handler: async ({ query }) => {
    // Call MCP server internally
  }
})
```

### Option B: Drop MCP Initially
Focus on core chat functionality first, add MCP bridge later.

**Recommendation:** Option B for MVP, Option A for v2.

---

## 8. Implementation Phases

### Phase 1: Basic Chat (1-2 days)
- [ ] Install Copilot SDK
- [ ] Create `copilot.ts` router with basic send/receive
- [ ] Map events to UIMessageChunk
- [ ] Test single-turn conversation

### Phase 2: Streaming & Sessions (1 day)
- [ ] Enable streaming mode
- [ ] Implement session persistence
- [ ] Handle abort/cancel

### Phase 3: Authentication (1 day)
- [ ] GitHub OAuth flow in Electron
- [ ] Token storage (keychain)
- [ ] Login UI

### Phase 4: Model Selection (0.5 day)
- [ ] Add model dropdown UI
- [ ] Persist model preference
- [ ] List available models from SDK

### Phase 5: Tools & MCP (2+ days)
- [ ] Port file editing tools
- [ ] Port terminal tools
- [ ] MCP bridge (optional)

### Phase 6: Polish (1+ day)
- [ ] Error handling
- [ ] Offline detection
- [ ] Settings migration
- [ ] Documentation

---

## 9. Dependencies

### Remove
```json
"@anthropic-ai/claude-agent-sdk": "0.2.32"
```

### Add
```json
"@github/copilot-sdk": "^0.1.22"
```

### Keep (if using CLI login)
Ensure `@github/copilot` (CLI) is installed globally or bundled.

---

## 10. Open Questions

1. **Binary bundling:** Should we bundle Copilot CLI like 1Code bundles Claude CLI, or require global install?

2. **MCP priority:** How important is MCP support for initial release?

3. **Dual-mode:** Support both Claude SDK and Copilot SDK, or full replacement?

4. **Naming:** Keep "1Code" branding or rename to indicate Copilot support?

---

## 11. Resources

- **Copilot SDK Repo:** https://github.com/github/copilot-sdk
- **SDK Docs:** https://github.com/github/copilot-sdk/blob/main/docs/getting-started.md
- **Auth Docs:** https://github.com/github/copilot-sdk/blob/main/docs/auth/index.md
- **Node.js SDK:** https://github.com/github/copilot-sdk/tree/main/nodejs
- **NPM:** https://www.npmjs.com/package/@github/copilot-sdk
- **Copilot CLI:** https://github.com/features/copilot/cli

---

## 12. Next Steps

1. ✅ Fork repo and clone locally
2. ✅ Document current architecture
3. ✅ Research Copilot SDK API
4. 🔲 Create feature branch `feat/copilot-sdk`
5. 🔲 Install Copilot SDK
6. 🔲 Create minimal `copilot.ts` router
7. 🔲 Test basic chat flow
8. 🔲 Iterate on event mapping

---

*Last updated: 2026-02-07 01:30*
