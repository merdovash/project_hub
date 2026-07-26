import { useEffect, useState } from 'react'
import { AuthPanel } from './components/AuthPanel'
import { fetchServices, type PublicService } from './lib/servicesApi'
import { useAuthStore } from './store/authStore'

export default function App() {
  const init = useAuthStore((s) => s.init)
  const user = useAuthStore((s) => s.user)
  const initialized = useAuthStore((s) => s.initialized)
  const [services, setServices] = useState<PublicService[]>([])
  const [domain, setDomain] = useState('example.com')
  const [servicesError, setServicesError] = useState<string | null>(null)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (!user) return
    const params = new URLSearchParams(window.location.search)
    const returnTo = params.get('return')
    if (!returnTo) return
    try {
      const target = new URL(returnTo)
      // Only allow return to same parent domain (or localhost in dev)
      const allowed =
        target.hostname === window.location.hostname ||
        target.hostname.endsWith(`.${domain}`) ||
        target.hostname === 'localhost' ||
        target.hostname.endsWith('.localhost')
      if (allowed) {
        window.location.replace(returnTo)
      }
    } catch {
      /* ignore bad return URL */
    }
  }, [user, domain])

  useEffect(() => {
    void fetchServices()
      .then((data) => {
        setServices(data.services)
        setDomain(data.domain)
      })
      .catch((err) => {
        setServicesError(err instanceof Error ? err.message : 'Ошибка загрузки')
      })
  }, [])

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-5 py-8 sm:px-8 sm:py-12">
      <header className="animate-rise flex flex-wrap items-end justify-between gap-6">
        <div>
          <p className="font-[Fraunces,serif] text-4xl font-semibold tracking-tight text-[var(--ink)] sm:text-5xl">
            Portal
          </p>
          <p className="mt-2 max-w-md text-sm text-[var(--muted)] sm:text-base">
            Единый вход и каталог сервисов на {domain}
          </p>
        </div>
        <div className="animate-fade min-w-[16rem]">
          <AuthPanel />
        </div>
      </header>

      <main className="mt-12 flex-1">
        <section className="animate-rise" style={{ animationDelay: '80ms' }}>
          <h2 className="font-[Fraunces,serif] text-2xl font-semibold text-[var(--ink)]">Сервисы</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {user
              ? 'Откройте нужный сервис — сессия уже общая.'
              : 'Войдите, чтобы пользоваться сервисами с одной учётной записью.'}
          </p>

          {!initialized ? (
            <p className="mt-8 text-sm text-[var(--muted)]">Загрузка…</p>
          ) : servicesError ? (
            <p className="mt-8 text-sm text-red-700">{servicesError}</p>
          ) : services.length === 0 ? (
            <p className="mt-8 text-sm text-[var(--muted)]">Нет включённых сервисов в конфиге.</p>
          ) : (
            <ul className="mt-8 grid gap-4 sm:grid-cols-2">
              {services.map((svc, i) => (
                <li
                  key={svc.id}
                  className="animate-rise rounded-2xl border border-[var(--line)] bg-[var(--panel)]/80 p-5 backdrop-blur-sm transition hover:border-[var(--accent)] hover:shadow-[0_12px_40px_-24px_rgba(31,107,74,0.45)]"
                  style={{ animationDelay: `${120 + i * 60}ms` }}
                >
                  <a href={svc.url} className="block outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
                    <h3 className="font-[Fraunces,serif] text-xl font-semibold text-[var(--ink)]">{svc.name}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-[var(--muted)]">{svc.description}</p>
                    <p className="mt-4 text-xs font-medium tracking-wide text-[var(--accent)]">
                      {svc.subdomain}.{domain} →
                    </p>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      <footer className="mt-16 border-t border-[var(--line)] pt-6 text-xs text-[var(--muted)]">
        Поддомены третьего уровня · общая авторизация · одна БД
      </footer>
    </div>
  )
}
