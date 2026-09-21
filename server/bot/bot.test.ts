import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BLOCK_MS,
  blockedForMs,
  grantSession,
  isAuthed,
  MAX_FAILED_ATTEMPTS,
  registerFailedAttempt,
  revokeSession,
  SESSION_TTL_MS_DEFAULT,
} from './state'
import { formatBytes, formatDuration } from './system'
import { chunkText, escapeHtml } from './telegram'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-state-'))
  process.env.BOT_DATA_DIR = tmpDir
})

afterEach(() => {
  delete process.env.BOT_DATA_DIR
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('bot sessions', () => {
  it('grants a session valid for the TTL and expires after it', () => {
    const now = 1_000_000
    grantSession(42, SESSION_TTL_MS_DEFAULT, now)
    expect(isAuthed(42, now)).toBe(true)
    expect(isAuthed(42, now + SESSION_TTL_MS_DEFAULT - 1)).toBe(true)
    expect(isAuthed(42, now + SESSION_TTL_MS_DEFAULT)).toBe(false)
    expect(isAuthed(999, now)).toBe(false)
  })

  it('revokes a session on logout', () => {
    const now = 1_000_000
    grantSession(42, SESSION_TTL_MS_DEFAULT, now)
    revokeSession(42)
    expect(isAuthed(42, now)).toBe(false)
  })

  it('persists sessions across state reloads (file-backed)', () => {
    const now = 1_000_000
    grantSession(42, SESSION_TTL_MS_DEFAULT, now)
    const raw = JSON.parse(fs.readFileSync(path.join(tmpDir, 'bot-state.json'), 'utf8'))
    expect(raw.sessions['42']).toBe(now + SESSION_TTL_MS_DEFAULT)
  })
})

describe('bot rate limiting', () => {
  it('blocks after MAX_FAILED_ATTEMPTS wrong passwords', () => {
    const now = 1_000_000
    let last = { remaining: MAX_FAILED_ATTEMPTS, blockedForMs: 0 }
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i += 1) {
      last = registerFailedAttempt(7, now + i)
    }
    expect(last.blockedForMs).toBe(BLOCK_MS)
    expect(blockedForMs(7, now + 10)).toBeGreaterThan(0)
    expect(blockedForMs(7, now + 10 + BLOCK_MS)).toBe(0)
  })

  it('resets attempt counter after successful auth', () => {
    const now = 1_000_000
    registerFailedAttempt(7, now)
    registerFailedAttempt(7, now + 1)
    grantSession(7, SESSION_TTL_MS_DEFAULT, now + 2)
    const next = registerFailedAttempt(7, now + 3)
    expect(next.remaining).toBe(MAX_FAILED_ATTEMPTS - 1)
  })
})

describe('formatting helpers', () => {
  it('formats byte sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe('5.0 GB')
  })

  it('formats durations', () => {
    expect(formatDuration(5 * 60 * 1000)).toBe('5м')
    expect(formatDuration(90 * 60 * 1000)).toBe('1ч 30м')
    expect(formatDuration(26 * 60 * 60 * 1000)).toBe('1д 2ч')
  })

  it('escapes html', () => {
    expect(escapeHtml('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;')
  })

  it('splits long messages on line boundaries', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line-${i}`.repeat(20)).join('\n')
    const chunks = chunkText(text, 500)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.length <= 500)).toBe(true)
    expect(chunks.join('\n')).toBe(text)
  })
})
