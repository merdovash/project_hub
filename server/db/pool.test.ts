import fs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadEnvFile, resetEnvFileCache } from './pool'

const TEST_KEY = 'ENV_FILE_CACHE_TEST'

afterEach(() => {
  delete process.env[TEST_KEY]
  resetEnvFileCache()
  vi.restoreAllMocks()
})

describe('loadEnvFile', () => {
  it('reads the current env file only once', () => {
    const exists = vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    const read = vi.spyOn(fs, 'readFileSync').mockReturnValue(`${TEST_KEY}=loaded`)

    loadEnvFile()
    loadEnvFile()

    expect(process.env[TEST_KEY]).toBe('loaded')
    expect(exists).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('can be explicitly invalidated', () => {
    const read = vi.spyOn(fs, 'readFileSync').mockReturnValue(`${TEST_KEY}=loaded`)
    vi.spyOn(fs, 'existsSync').mockReturnValue(true)

    loadEnvFile()
    resetEnvFileCache()
    loadEnvFile()

    expect(read).toHaveBeenCalledTimes(2)
  })
})
