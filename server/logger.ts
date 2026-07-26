import fs from 'node:fs'
import path from 'node:path'

const LOG_DIR = path.resolve(process.cwd(), 'logs')
const ERROR_LOG = path.join(LOG_DIR, 'server-error.log')

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    const stack = err.stack ?? `${err.name}: ${err.message}`
    const extra =
      'code' in err && (err as { code?: string }).code
        ? `\ncode=${String((err as { code?: string }).code)}`
        : ''
    return `${stack}${extra}`
  }
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

export function logServerError(context: string, err: unknown): void {
  const stamp = new Date().toISOString()
  const block = `[${stamp}] ${context}\n${formatError(err)}\n\n`
  try {
    ensureLogDir()
    fs.appendFileSync(ERROR_LOG, block, 'utf-8')
  } catch (writeErr) {
    console.error('[logger] failed to write log file', writeErr)
  }
  console.error(`[${context}]`, err)
}

export function isDbConnectionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = 'code' in err ? String((err as { code?: unknown }).code ?? '') : ''
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') return true
  const message = err instanceof Error ? err.message : String(err)
  return /ECONNREFUSED|connect ECONNREFUSED|Connection refused/i.test(message)
}

export function publicErrorMessage(err: unknown): { status: number; error: string } {
  if (isDbConnectionError(err)) {
    return {
      status: 503,
      error:
        'База данных недоступна. Запустите PostgreSQL (npm run db:up или db:setup), затем npm run db:migrate.',
    }
  }
  return { status: 500, error: 'Внутренняя ошибка сервера' }
}
