import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPool, loadEnvFile } from './pool'

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'migrations',
)

async function ensureMigrationsTable(): Promise<void> {
  const pool = getPool()
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
}

async function appliedIds(): Promise<Set<string>> {
  const pool = getPool()
  const result = await pool.query<{ id: string }>('SELECT id FROM schema_migrations')
  return new Set(result.rows.map((row) => row.id))
}

export async function migrate(): Promise<string[]> {
  loadEnvFile()
  await ensureMigrationsTable()
  const done = await appliedIds()
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()

  const applied: string[] = []
  const pool = getPool()

  for (const file of files) {
    if (done.has(file)) continue
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    await pool.query(sql)
    await pool.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file])
    applied.push(file)
    console.log(`Applied ${file}`)
  }

  if (applied.length === 0) {
    console.log('No new migrations')
  }
  return applied
}
