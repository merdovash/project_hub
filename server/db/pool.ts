import fs from 'node:fs'
import path from 'node:path'
import { Pool } from './pgClient'

let pool: Pool | null = null

export function loadEnvFile(): void {
  const envPath = path.resolve(process.cwd(), '.env')
  if (!fs.existsSync(envPath)) return
  const text = fs.readFileSync(envPath, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

export function getPool(): Pool {
  if (!pool) {
    loadEnvFile()
    pool = new Pool(process.env.DATABASE_URL)
  }
  return pool
}

export function resetPool(): void {
  pool = null
}
