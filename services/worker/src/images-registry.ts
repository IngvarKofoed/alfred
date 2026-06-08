import { GeminiImageProvider, type ImageProvider, ImagenProvider } from '@alfred/agent-core'
import { loadConfig } from '@alfred/shared'

// The image-model registry — the source of truth for which image models generate_image can
// pick. Built alongside catalog.ts (it binds the concrete model ids the worker ships), it
// maps each id to its ImageProvider so the tool's `model` enum is derived from real wiring
// and can't drift (same discipline as the tool catalog deriving from real Tool instances).

// The default model when generate_image's `model` arg is omitted (unchanged behaviour).
export const DEFAULT_IMAGE_MODEL = 'gemini-2.5-flash-image'

// The six models, each with a short description surfaced in the tool's `model` enum docs.
// Gemini-native ("Nano Banana") use the generateContent API; Imagen 4 uses generateImages.
const IMAGE_MODELS: { id: string; description: string; api: 'gemini' | 'imagen' }[] = [
  { id: 'gemini-2.5-flash-image', api: 'gemini', description: 'Nano Banana — fast, general creative/editing (default)' },
  { id: 'gemini-3.1-flash-image', api: 'gemini', description: 'Nano Banana 2 — newer, production-scale' },
  { id: 'gemini-3-pro-image', api: 'gemini', description: 'Nano Banana Pro — studio-quality, 4K, precise text/layout' },
  { id: 'imagen-4.0-fast-generate-001', api: 'imagen', description: 'Imagen 4 Fast — cheapest, volume' },
  { id: 'imagen-4.0-generate-001', api: 'imagen', description: 'Imagen 4 — standard text-to-image' },
  { id: 'imagen-4.0-ultra-generate-001', api: 'imagen', description: 'Imagen 4 Ultra — tightest prompt adherence' },
]

// Providers are built lazily on first use so importing the registry (e.g. for the enum) never
// requires GEMINI_API_KEY; the construction error surfaces only when a generation is attempted.
const providerCache = new Map<string, ImageProvider>()

// The model ids + descriptions for the generate_image `model` enum.
export function imageModelChoices(): { id: string; description: string }[] {
  return IMAGE_MODELS.map(({ id, description }) => ({ id, description }))
}

// Resolve a model id to its ImageProvider. Throws on an unknown id.
export function resolveImageProvider(model: string): ImageProvider {
  const cached = providerCache.get(model)
  if (cached) return cached
  const entry = IMAGE_MODELS.find((m) => m.id === model)
  if (!entry) throw new Error(`unknown image model: ${model}`)
  const apiKey = loadConfig().GEMINI_API_KEY
  const provider =
    entry.api === 'imagen'
      ? new ImagenProvider(model, { apiKey })
      : new GeminiImageProvider(model, { apiKey })
  providerCache.set(model, provider)
  return provider
}
