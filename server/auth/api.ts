import type { IncomingMessage, ServerResponse } from 'node:http'
import { getPool } from '../db/pool'
import { hashPassword, verifyPassword } from './password'
import {
  clearSessionCookie,
  createSession,
  destroySession,
  getSessionToken,
  getUserFromRequest,
  setSessionCookie,
} from './session'

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  let raw = ''
  for await (const chunk of req) {
    raw += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8')
  }
  return JSON.parse(raw || '{}') as T
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function validateCredentials(email: string, password: string): string | null {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return 'Укажите корректный email'
  }
  if (!password || password.length < 6) {
    return 'Пароль должен быть не короче 6 символов'
  }
  return null
}

export async function handleAuthApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const method = req.method ?? 'GET'

  if (pathname === '/api/auth/me' && method === 'GET') {
    const user = await getUserFromRequest(req)
    sendJson(res, 200, { user })
    return true
  }

  if (pathname === '/api/auth/register' && method === 'POST') {
    const body = await readJsonBody<{ email?: string; password?: string }>(req)
    const email = normalizeEmail(body.email ?? '')
    const password = body.password ?? ''
    const error = validateCredentials(email, password)
    if (error) {
      sendJson(res, 400, { error })
      return true
    }

    const pool = getPool()
    const existing = await pool.query(`SELECT id FROM users WHERE email = $1`, [email])
    if (existing.rows.length > 0) {
      sendJson(res, 409, { error: 'Пользователь с таким email уже зарегистрирован' })
      return true
    }

    const passwordHash = hashPassword(password)
    const inserted = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email`,
      [email, passwordHash],
    )
    const user = inserted.rows[0]!
    const token = await createSession(String(user.id))
    setSessionCookie(res, token)
    sendJson(res, 201, { user: { id: String(user.id), email: String(user.email) } })
    return true
  }

  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await readJsonBody<{ email?: string; password?: string }>(req)
    const email = normalizeEmail(body.email ?? '')
    const password = body.password ?? ''
    const error = validateCredentials(email, password)
    if (error) {
      sendJson(res, 400, { error })
      return true
    }

    const pool = getPool()
    const found = await pool.query<{ id: string; email: string; password_hash: string }>(
      `SELECT id, email, password_hash FROM users WHERE email = $1`,
      [email],
    )
    const row = found.rows[0]
    if (!row || !verifyPassword(password, String(row.password_hash))) {
      sendJson(res, 401, { error: 'Неверный email или пароль' })
      return true
    }

    const token = await createSession(String(row.id))
    setSessionCookie(res, token)
    sendJson(res, 200, { user: { id: String(row.id), email: String(row.email) } })
    return true
  }

  if (pathname === '/api/auth/logout' && method === 'POST') {
    await destroySession(getSessionToken(req))
    clearSessionCookie(res)
    sendJson(res, 200, { ok: true })
    return true
  }

  return false
}
