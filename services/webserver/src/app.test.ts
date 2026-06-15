import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Point the workspace at a temp dir before app.ts (via loadConfig) caches the config.
const workspaceRoot = mkdtempSync(path.join(tmpdir(), 'alfred-ws-'))
process.env.WORKSPACE_ROOT = workspaceRoot

const { app } = await import('./app')
const { describe, expect, it } = await import('vitest')

const CONV = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'

describe('webserver', () => {
  it('GET /api/health returns { ok: true } with a version string', async () => {
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; version: string }
    expect(body.ok).toBe(true)
    expect(typeof body.version).toBe('string')
  })

  it('POST /files uploads an image and GET /media serves it back', async () => {
    const png = new File([new Uint8Array([1, 2, 3, 4])], 'photo.png', { type: 'image/png' })
    const form = new FormData()
    form.set('file', png)
    const up = await app.request(`/api/conversations/${CONV}/files`, { method: 'POST', body: form })
    expect(up.status).toBe(200)
    const { path: relPath, mimeType } = (await up.json()) as { path: string; mimeType: string }
    expect(mimeType).toBe('image/png')
    expect(relPath).toMatch(/^upload-\d+-photo\.png$/)

    const media = await app.request(`/media/${CONV}/${relPath}`)
    expect(media.status).toBe(200)
    expect(media.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4]))
  })

  it('POST /files rejects an unsupported type with 415', async () => {
    const txt = new File([new Uint8Array([0])], 'note.txt', { type: 'text/plain' })
    const form = new FormData()
    form.set('file', txt)
    const res = await app.request(`/api/conversations/${CONV}/files`, { method: 'POST', body: form })
    expect(res.status).toBe(415)
  })

  it('POST /files rejects a missing file with 400', async () => {
    const res = await app.request(`/api/conversations/${CONV}/files`, {
      method: 'POST',
      body: new FormData(),
    })
    expect(res.status).toBe(400)
  })

  it('GET /media rejects a traversal filename', async () => {
    const res = await app.request(`/media/${CONV}/..%2F..%2Fsecret.txt`)
    expect(res.status).toBe(400)
  })

  it('GET /media 404s a missing file', async () => {
    const res = await app.request(`/media/${CONV}/upload-0-nope.png`)
    expect(res.status).toBe(404)
  })
})
