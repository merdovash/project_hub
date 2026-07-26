import type { IncomingMessage, ServerResponse } from 'node:http'
import { createSessionToken, hashToken } from './password'
import { getPool } from '../db/pool'

export const SESSION_COOKIE = 'session'
const SESSION_DAYS = 30

export interface AuthUser {
  id: string
  email: string
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {}
  const out: Record<string, string> = {}
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const key = part.slice(0, idx).trim()
    const value = decodeURIComponent(part.slice(idx + 1).trim())
    out[key] = value
  }
  return out
}

function cookieDomainAttr(): string {
  const domain = process.env.COOKIE_DOMAIN?.trim()
  if (!domain) return ''
  return `; Domain=${domain}`
}

export function getSessionToken(req: IncomingMessage): string | undefined {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE]
}

export function setSessionCookie(res: ServerResponse, token: string): void {
  const maxAge = SESSION_DAYS * 24 * 60 * 60
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}${cookieDomainAttr()}`,
  )
}

export function clearSessionCookie(res: ServerResponse): void {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}${cookieDomainAttr()}`,
  )
}

export async function createSession(userId: string): Promise<string> {
  const token = createSessionToken()
  const tokenHash = hashToken(token)
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000)
  const pool = getPool()
  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3::timestamptz)`,
    [userId, tokenHash, expires.toISOString()],
  )
  return token
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return
  const pool = getPool()
  await pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)])
}

export async function getUserFromRequest(req: IncomingMessage): Promise<AuthUser | null> {
  const token = getSessionToken(req)
  if (!token) return null
  const pool = getPool()
  const result = await pool.query<{ id: string; email: string }>(
    `SELECT u.id, u.email
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  )
  const row = result.rows[0]
  if (!row) return null
  return { id: String(row.id), email: String(row.email) }
}
