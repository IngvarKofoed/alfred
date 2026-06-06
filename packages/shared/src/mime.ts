// Canonical image MIME ↔ file-extension mapping, shared across the stack so upload
// validation (webserver), on-disk naming (worker images), file serving (webserver /media),
// and the read_file image check (worker tools) all read from one allowlist and can't drift.

const IMAGE_MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

const EXT_TO_IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

// Canonical extension (no dot) for an accepted image MIME type, or undefined if the type is
// not an accepted image — callers use the undefined to reject an upload / fall back.
export function extForImageMime(mimeType: string): string | undefined {
  return IMAGE_MIME_TO_EXT[mimeType]
}

// Image MIME type for a file extension, tolerant of a leading dot and case
// (e.g. '.PNG', 'png' → 'image/png'). Undefined when the extension isn't an accepted image.
export function imageMimeForExt(ext: string): string | undefined {
  return EXT_TO_IMAGE_MIME[ext.replace(/^\./, '').toLowerCase()]
}
