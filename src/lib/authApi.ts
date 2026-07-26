export interface AuthUser {
  id: string
  email: string
}

async function parseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string }
    return body.error ?? response.statusText
  } catch {
    return response.statusText
  }
}

const jsonHeaders = { 'Content-Type': 'application/json' }

export async function fetchMe(): Promise<AuthUser | null> {
  const response = await fetch('/api/auth/me', { credentials: 'include' })
  if (!response.ok) throw new Error(await parseError(response))
  const body = (await response.json()) as { user: AuthUser | null }
  return body.user
}

export async function login(email: string, password: string): Promise<AuthUser> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: jsonHeaders,
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) throw new Error(await parseError(response))
  const body = (await response.json()) as { user: AuthUser }
  return body.user
}

export async function register(email: string, password: string): Promise<AuthUser> {
  const response = await fetch('/api/auth/register', {
    method: 'POST',
    credentials: 'include',
    headers: jsonHeaders,
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) throw new Error(await parseError(response))
  const body = (await response.json()) as { user: AuthUser }
  return body.user
}

export async function logout(): Promise<void> {
  const response = await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'include',
  })
  if (!response.ok) throw new Error(await parseError(response))
}
