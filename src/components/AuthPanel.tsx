import { useEffect, useState, type FormEvent } from 'react'
import { useAuthStore } from '../store/authStore'

export function AuthPanel() {
  const user = useAuthStore((s) => s.user)
  const loading = useAuthStore((s) => s.loading)
  const error = useAuthStore((s) => s.error)
  const login = useAuthStore((s) => s.login)
  const register = useAuthStore((s) => s.register)
  const logout = useAuthStore((s) => s.logout)
  const clearError = useAuthStore((s) => s.clearError)

  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  useEffect(() => {
    clearError()
  }, [mode, clearError])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    try {
      if (mode === 'login') await login(email, password)
      else await register(email, password)
      setPassword('')
    } catch {
      /* error in store */
    }
  }

  if (user) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-[var(--muted)]">{user.email}</span>
        <button
          type="button"
          disabled={loading}
          onClick={() => void logout()}
          className="rounded-lg border border-[var(--line)] bg-white/70 px-3 py-1.5 text-sm font-medium text-[var(--ink)] transition hover:bg-white disabled:opacity-50"
        >
          Выйти
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-3">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setMode('login')}
          className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
            mode === 'login'
              ? 'bg-[var(--accent)] text-white'
              : 'border border-[var(--line)] bg-white/60 text-[var(--muted)]'
          }`}
        >
          Вход
        </button>
        <button
          type="button"
          onClick={() => setMode('register')}
          className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
            mode === 'register'
              ? 'bg-[var(--accent)] text-white'
              : 'border border-[var(--line)] bg-white/60 text-[var(--muted)]'
          }`}
        >
          Регистрация
        </button>
      </div>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-[var(--muted)]">Email</span>
        <input
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-lg border border-[var(--line)] bg-white/80 px-3 py-2 text-sm outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-[var(--muted)]">Пароль</span>
        <input
          type="password"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full rounded-lg border border-[var(--line)] bg-white/80 px-3 py-2 text-sm outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]"
        />
      </label>
      {error && <p className="text-xs text-red-700">{error}</p>}
      <button
        type="submit"
        disabled={loading || !email.trim() || password.length < 6}
        className="w-full rounded-lg bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
      >
        {loading ? '…' : mode === 'login' ? 'Войти' : 'Создать аккаунт'}
      </button>
    </form>
  )
}
