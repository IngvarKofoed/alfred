import { loadConfig } from '@alfred/shared'
import { GoogleGenAI } from '@google/genai'

// The provider abstraction for image generation — the visual sibling of LlmProvider
// (provider.ts). One uniform shape regardless of the underlying API: the worker dispatches
// to a concrete impl via a model registry. Gemini-native and Imagen are two different API
// surfaces (generateContent + inlineData vs. generateImages + imageBytes), hence two impls.

// images: count of output images (the cost basis for flat-per-image models like Imagen).
// The token counts are recorded for observability; for Gemini-native image models they also
// drive cost (output billed per token), for Imagen they're absent (it reports no tokens).
export interface ImageUsage {
  model: string
  images: number
  promptTokens?: number
  completionTokens?: number
  cachedTokens?: number
}

export interface GeneratedImage {
  mimeType: string
  data: string // base64
  usage?: ImageUsage
}

export interface ImageProvider {
  readonly model: string
  // `signal` matches the LlmProvider seam; it is inert until run cancellation is wired (§10.6).
  generate(prompt: string, opts?: { signal?: AbortSignal }): Promise<GeneratedImage>
}

// GeminiImageProvider — the "Nano Banana" models over the generateContent API. Shares the
// inlineData extraction the generate_image tool used inline before this abstraction, and
// reads usageMetadata for token counts (as GeminiProvider.stream does, gemini.ts:69-73).
export class GeminiImageProvider implements ImageProvider {
  readonly model: string
  private readonly ai: GoogleGenAI

  constructor(model: string, opts?: { apiKey?: string }) {
    const apiKey = opts?.apiKey ?? loadConfig().GEMINI_API_KEY
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not set — required for the Gemini image provider')
    }
    this.ai = new GoogleGenAI({ apiKey })
    this.model = model
  }

  async generate(prompt: string): Promise<GeneratedImage> {
    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    })

    // The image rides on a candidate part's inlineData ({ mimeType, data:<base64> }).
    const parts = response.candidates?.[0]?.content?.parts ?? []
    const inline = parts.find((p) => p.inlineData?.data)?.inlineData
    if (!inline?.data) throw new Error(`${this.model}: the model returned no image`)

    const meta = response.usageMetadata
    return {
      mimeType: inline.mimeType ?? 'image/png',
      data: inline.data,
      usage: {
        model: this.model,
        images: 1,
        promptTokens: meta?.promptTokenCount,
        // promptTokenCount is the TOTAL input incl. cached; this is the cached subset.
        cachedTokens: meta?.cachedContentTokenCount,
        completionTokens: meta?.candidatesTokenCount,
      },
    }
  }
}

// ImagenProvider — the Imagen 4 models over the generateImages API. Bytes come back on
// generatedImages[].image.imageBytes; Imagen reports no token usage, so cost is flat per
// image (pricing.ts perImageOutput) and usage carries only the image count.
export class ImagenProvider implements ImageProvider {
  readonly model: string
  private readonly ai: GoogleGenAI

  constructor(model: string, opts?: { apiKey?: string }) {
    const apiKey = opts?.apiKey ?? loadConfig().GEMINI_API_KEY
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not set — required for the Imagen image provider')
    }
    this.ai = new GoogleGenAI({ apiKey })
    this.model = model
  }

  async generate(prompt: string): Promise<GeneratedImage> {
    const response = await this.ai.models.generateImages({
      model: this.model,
      prompt,
      config: { numberOfImages: 1 },
    })

    const image = response.generatedImages?.[0]?.image
    if (!image?.imageBytes) throw new Error(`${this.model}: the model returned no image`)

    return {
      mimeType: image.mimeType ?? 'image/png',
      data: image.imageBytes,
      usage: { model: this.model, images: 1 },
    }
  }
}
