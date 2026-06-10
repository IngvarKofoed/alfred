import fs from 'node:fs'
import path from 'node:path'
import { type ImageToolResult, type Tool, type ToolContext } from '@alfred/agent-core'
import { conversations, getDb } from '@alfred/db'
import { imageMimeForExt, resolveInWorkspace } from '@alfred/shared'
import { eq } from 'drizzle-orm'
import { capResult } from './cap.js'
import { DEFAULT_IMAGE_MODEL, imageModelChoices, resolveImageProvider } from './images-registry.js'

// A context-bound built-in tool (ARCHITECTURE §7.3): it acts on a specific
// conversation, captured in a closure so Tool.invoke(args) stays context-free.
// trustTier 'write' ⇒ the loop pauses for owner approval before it runs.
export function makeSetTitleTool(conversationId: string): Tool {
  return {
    name: 'set_conversation_title',
    description: 'Set the title of the current conversation.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', description: 'New conversation title' } },
      required: ['title'],
    },
    trustTier: 'write',
    async invoke(args: unknown): Promise<unknown> {
      const title = String((args as { title?: unknown } | null)?.title)
      await getDb()
        .update(conversations)
        .set({ title })
        .where(eq(conversations.id, conversationId))
      return { ok: true, title }
    },
  }
}

// ask_user: the agent asks the owner a structured question mid-run and blocks on the answer
// (§7.3, §10.2). `pause` is the run-bound function from run.ts that raises a question
// interaction and waits for the resolution; this tool just validates + shapes the prompt and
// returns whatever pause gives back. read-tier — asking is not side-effecting, so it must not
// itself trigger an approval card before the question.
export function makeAskUserTool(pause: (callId: string, prompt: unknown) => Promise<unknown>): Tool {
  return {
    name: 'ask_user',
    description:
      'Ask the user a structured question and wait for their answer. Use when you need a ' +
      'decision or missing information to proceed.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the user.' },
        options: {
          type: 'array',
          description: 'Optional answer choices for the user to pick from.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'The choice text.' },
              description: { type: 'string', description: 'Optional clarifying detail.' },
            },
            required: ['label'],
          },
        },
        multi_select: { type: 'boolean', description: 'Allow selecting more than one option (default false).' },
        allow_freeform: {
          type: 'boolean',
          description: 'Allow a free-text answer (default true); pass false to constrain to options.',
        },
      },
      required: ['question'],
    },
    trustTier: 'read',
    // Pauses mid-invoke to wait for the owner's answer, so the worker records its tool_calls
    // row as 'pending' (pending → awaiting_user → done, §10.9), not the read-tier shortcut.
    pausesForInput: true,
    async invoke(args: unknown, ctx?: ToolContext): Promise<unknown> {
      const {
        question: rawQuestion,
        options: rawOptions,
        multi_select,
        allow_freeform,
      } = (args ?? {}) as {
        question?: unknown
        options?: unknown
        multi_select?: unknown
        allow_freeform?: unknown
      }
      const question = String(rawQuestion ?? '')
      if (!question) throw new Error('ask_user requires a non-empty question')

      let options: { label: string; description?: string }[] | undefined
      if (rawOptions != null) {
        if (!Array.isArray(rawOptions)) throw new Error('ask_user options must be an array')
        options = rawOptions.map((o) => {
          const { label, description } = (o ?? {}) as { label?: unknown; description?: unknown }
          const labelStr = String(label ?? '')
          if (!labelStr) throw new Error('ask_user options each require a non-empty label')
          return description != null ? { label: labelStr, description: String(description) } : { label: labelStr }
        })
      }

      // The DATABASE.md question prompt shape.
      const prompt = {
        question,
        options,
        multi_select: multi_select === true,
        allow_freeform: allow_freeform !== false,
      }
      // callId is always supplied by the loop (ToolContext.callId = the call id); assert it
      // rather than defaulting, so the tool_calls row is reliably linked for the awaiting_user
      // flip (invariant 2, §10.9) instead of silently passing an unmatchable empty id.
      if (!ctx?.callId) throw new Error('ask_user requires ctx.callId from the agent loop')
      return await pause(ctx.callId, prompt)
    },
  }
}

// The image-model choices, read once from the registry (so they can't drift from what's
// wired). Both the `model` enum (ids) and its description — one line per id, since JSON-schema
// enum has no per-value docs — derive from this single list.
const IMAGE_MODEL_CHOICES = imageModelChoices()
const IMAGE_MODEL_IDS = IMAGE_MODEL_CHOICES.map((m) => m.id)
const MODEL_ENUM_DESCRIPTION =
  `Image model to use (default ${DEFAULT_IMAGE_MODEL}). ` +
  IMAGE_MODEL_CHOICES.map((m) => `${m.id}: ${m.description}`).join('; ')

// generate_image: produce an image from a text prompt, returning an ImageToolResult the worker
// persists (bytes -> workspace, reference -> tool_calls.result) and the model sees (image-feedback
// path, so "now make it bluer" works). The model is chosen per call via the `model` arg, resolved
// through the image registry (Gemini-native or Imagen). write-tier ⇒ approval-gated by default.
export function makeGenerateImageTool(): Tool {
  return {
    name: 'generate_image',
    description: 'Generate an image from a text prompt. The image is shown in the chat and you can see it too.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Description of the image to generate' },
        model: { type: 'string', enum: IMAGE_MODEL_IDS, description: MODEL_ENUM_DESCRIPTION },
      },
      required: ['prompt'],
    },
    trustTier: 'write',
    async invoke(args: unknown, ctx?: ToolContext): Promise<unknown> {
      const { prompt: rawPrompt, model: rawModel } = (args ?? {}) as { prompt?: unknown; model?: unknown }
      const prompt = String(rawPrompt ?? '')
      if (!prompt) throw new Error('generate_image requires a non-empty prompt')
      const model = typeof rawModel === 'string' && rawModel ? rawModel : DEFAULT_IMAGE_MODEL

      const provider = resolveImageProvider(model)
      const startedAt = Date.now()
      const generated = await provider.generate(prompt)
      const latencyMs = Date.now() - startedAt

      const out: ImageToolResult = {
        // The summary is what the model sees as the tool result (the image bytes ride on a
        // sibling part it can also see). Frame it so the model knows it created the image and
        // the user can already view it — otherwise it tends to "thank you for providing the
        // image" as if the user supplied it.
        image: { mimeType: generated.mimeType, data: generated.data },
        summary: `Generated the image for "${prompt}" and displayed it to the user. They can see it now.`,
      }

      // Attribute this out-of-loop AI call to its tool_call so the cost reaches llm_calls /
      // agent_runs (never $0). usage.images drives cost for flat-per-image models (Imagen);
      // tokens drive it for Gemini-native. Summaries only — never the image base64.
      const usage = generated.usage
      await ctx?.recordLlmCall({
        model: usage?.model ?? model,
        images: usage?.images,
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens,
        cachedTokens: usage?.cachedTokens,
        // Record the prompt so the /debug llm_calls row is self-contained (it's otherwise
        // only recoverable from tool_calls.args). Never the image base64.
        requestSummary: prompt,
        responseSummary: 'generated image',
        latencyMs,
      })

      return out
    },
  }
}

// The per-conversation file tools (spec's minimal trio). Every path is resolved through
// resolveInWorkspace, which confines it under <WORKSPACE_ROOT>/<conversationId>/. list_files /
// read_file are read-tier; write_file is write-tier (approval-gated). Code execution and
// richer ops (move/delete/glob, binary write) come later on the same workspace.
export function makeFileTools(conversationId: string): Tool[] {
  return [
    {
      name: 'list_files',
      description: 'List the files in this conversation’s working directory.',
      inputSchema: { type: 'object', properties: {} },
      trustTier: 'read',
      async invoke(): Promise<unknown> {
        const dir = resolveInWorkspace(conversationId, '.')
        if (!fs.existsSync(dir)) return { files: [] }
        const files = fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => e.name)
        return { files }
      },
    },
    {
      name: 'read_file',
      description: 'Read a file from this conversation’s working directory. Image files are returned as images.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Workspace-relative path to read' } },
        required: ['path'],
      },
      trustTier: 'read',
      async invoke(args: unknown): Promise<unknown> {
        const relPath = String((args as { path?: unknown } | null)?.path ?? '')
        const abs = resolveInWorkspace(conversationId, relPath)
        const mimeType = imageMimeForExt(path.extname(relPath))
        if (mimeType) {
          const data = fs.readFileSync(abs).toString('base64')
          const out: ImageToolResult = { image: { mimeType, data }, summary: relPath }
          return out
        }
        // Same 100k cap as the browser/python tools — run_python can now write arbitrarily
        // large files, and an uncapped read would flood the model context.
        return { path: relPath, content: capResult(fs.readFileSync(abs, 'utf8')) }
      },
    },
    {
      name: 'write_file',
      description: 'Write text content to a file in this conversation’s working directory (overwrites).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path to write' },
          content: { type: 'string', description: 'Text content to write' },
        },
        required: ['path', 'content'],
      },
      trustTier: 'write',
      async invoke(args: unknown): Promise<unknown> {
        const { path: relPath, content } = (args ?? {}) as { path?: unknown; content?: unknown }
        const rel = String(relPath ?? '')
        const abs = resolveInWorkspace(conversationId, rel)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, String(content ?? ''), 'utf8')
        return { ok: true, path: rel }
      },
    },
  ]
}
