/** Persistent bot state: auth sessions (24h), password attempt limits, audit log. */
import fs from 'node:fs'
import path from 'node:path'

export const SESSION_TTL_MS_DEFAULT = 24 * 60 * 60 * 1000
export const MAX_FAILED_ATTEMPTS = 5
export const FAIL_WINDOW_MS = 15 * 60 * 1000
export const BLOCK_MS = 60 * 60 * 1000

interface AttemptInfo {
  fails: number[]
  blockedUntil?: number
}

interface BotStateFile {
  /** userId -> session expiry (ms epoch) */
  sessions: Record<string, number>
  attempts: Record<string, AttemptInfo>
}

export interface PendingDeploy {
  chatId: number
  logFile: string
  startedAt: number
  label: string
}

function dataDir(): string {
  return process.env.BOT_DATA_DIR?.trim() || path.resolve(process.cwd(), 'data')
}

function stateFile(): string {
  return path.join(dataDir(), 'bot-state.json')
}

function pendingFile(): string {
  return path.join(dataDir(), 'bot-pending-deploy.json')
}

function ensureDataDir(): void {
  const dir = dataDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function loadState(): BotStateFile {
  try {
    const file = stateFile()
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<BotStateFile>
      return {
        sessions: parsed.sessions ?? {},
        attempts: parsed.attempts ?? {},
      }
    }
  } catch {
    /* corrupted state — start fresh */
  }
  return { sessions: {}, attempts: {} }
}

function saveState(state: BotStateFile): void {
  ensureDataDir()
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2))
}

export function grantSession(userId: number, ttlMs: number, now: number = Date.now()): number {
  const state = loadState()
  const expiresAt = now + ttlMs
  state.sessions[String(userId)] = expiresAt
  delete state.attempts[String(userId)]
  saveState(state)
  return expiresAt
}

export function sessionExpiry(userId: number, now: number = Date.now()): number | null {
  const state = loadState()
  const expiresAt = state.sessions[String(userId)]
  if (!expiresAt || expiresAt <= now) return null
  return expiresAt
}

export function isAuthed(userId: number, now: number = Date.now()): boolean {
  return sessionExpiry(userId, now) !== null
}

export function revokeSession(userId: number): void {
  const state = loadState()
  delete state.sessions[String(userId)]
  saveState(state)
}

/** ms until unblocked, or 0 when not blocked. */
export function blockedForMs(userId: number, now: number = Date.now()): number {
  const state = loadState()
  const info = state.attempts[String(userId)]
  if (!info?.blockedUntil) return 0
  return Math.max(0, info.blockedUntil - now)
}

export interface FailResult {
  /** attempts left before block (0 = just blocked) */
  remaining: number
  blockedForMs: number
}

export function registerFailedAttempt(userId: number, now: number = Date.now()): FailResult {
  const state = loadState()
  const key = String(userId)
  const info: AttemptInfo = state.attempts[key] ?? { fails: [] }
  info.fails = info.fails.filter((t) => now - t < FAIL_WINDOW_MS)
  info.fails.push(now)
  let blocked = 0
  if (info.fails.length >= MAX_FAILED_ATTEMPTS) {
    info.blockedUntil = now + BLOCK_MS
    info.fails = []
    blocked = BLOCK_MS
  }
  state.attempts[key] = info
  saveState(state)
  return {
    remaining: blocked ? 0 : MAX_FAILED_ATTEMPTS - info.fails.length,
    blockedForMs: blocked,
  }
}

export function savePendingDeploy(pending: PendingDeploy): void {
  ensureDataDir()
  fs.writeFileSync(pendingFile(), JSON.stringify(pending, null, 2))
}

export function loadPendingDeploy(): PendingDeploy | null {
  try {
    const file = pendingFile()
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf8')) as PendingDeploy
  } catch {
    return null
  }
}

export function clearPendingDeploy(): void {
  const file = pendingFile()
  if (fs.existsSync(file)) fs.unlinkSync(file)
}

/** Append a line to logs/bot-audit.log (who did what and when). */
export function audit(userId: number, username: string | undefined, action: string): void {
  const dir = path.resolve(process.cwd(), 'logs')
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString()
    fs.appendFileSync(
      path.join(dir, 'bot-audit.log'),
      `[${stamp}] user=${userId}${username ? ` @${username}` : ''} ${action}\n`,
    )
  } catch {
    /* audit must never break the bot */
  }
  console.log(`[audit] user=${userId} ${action}`)
}
