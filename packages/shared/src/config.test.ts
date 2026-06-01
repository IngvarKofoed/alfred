import { describe, expect, it } from 'vitest'
import { loadConfig } from './config'

describe('loadConfig', () => {
  it('defaults WEBSERVER_PORT to 3000 when unset', () => {
    expect(loadConfig().WEBSERVER_PORT).toBe(3000)
  })
})
