import fs from 'node:fs'
import path from 'node:path'
import { type ImageToolResult, type Tool } from '@alfred/agent-core'
import { conversations, getDb } from '@alfred/db'
import { imageMimeForExt, loadConfig, resolveInWorkspace } from '@alfred/shared'
import { GoogleGenAI } from '@google/genai'
import { eq } from 'drizzle-orm'

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

// The Gemini image-generation model the generate_image tool calls. Pricing for it lives in
// agent-core/pricing.ts (MODEL_PRICING['gemini-2.5-flash-image']).
const IMAGE_MODEL = 'gemini-2.5-flash-image'

// generate_image: produce an image from a text prompt via Gemini, returning an ImageToolResult
// the worker persists (bytes -> workspace, reference -> tool_calls.result) and the model sees
// (image-feedback path, so "now make it bluer" works). write-tier ⇒ approval-gated by default.
export function makeGenerateImageTool(): Tool {
  return {
    name: 'generate_image',
    description: 'Generate an image from a text prompt. The image is shown in the chat and you can see it too.',
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string', description: 'Description of the image to generate' } },
      required: ['prompt'],
    },
    trustTier: 'write',
    async invoke(args: unknown): Promise<unknown> {
      const prompt = String((args as { prompt?: unknown } | null)?.prompt ?? '')
      if (!prompt) throw new Error('generate_image requires a non-empty prompt')

      // Reuse the GeminiProvider's client construction (see providers/gemini.ts): same env key.
      const apiKey = loadConfig().GEMINI_API_KEY
      if (!apiKey) throw new Error('GEMINI_API_KEY is not set — required for generate_image')
      const ai = new GoogleGenAI({ apiKey })

      const response = await ai.models.generateContent({
        model: IMAGE_MODEL,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      })

      // The image rides on a candidate part's inlineData ({ mimeType, data:<base64> }).
      const parts = response.candidates?.[0]?.content?.parts ?? []
      const inline = parts.find((p) => p.inlineData?.data)?.inlineData
      if (!inline?.data) throw new Error('generate_image: the model returned no image')

      const out: ImageToolResult = {
        image: { mimeType: inline.mimeType ?? 'image/png', data: inline.data },
        summary: `generated image for: ${prompt}`,
      }
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
        return { path: relPath, content: fs.readFileSync(abs, 'utf8') }
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
