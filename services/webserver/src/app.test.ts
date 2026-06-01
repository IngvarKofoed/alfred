import { describe, expect, it } from 'vitest'
import { app } from './app'

describe('webserver', () => {
  it('GET /api/health returns { ok: true }', async () => {
    const res = await app.request('/api/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})
