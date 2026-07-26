import { Pool, parseDatabaseUrl, toDatabaseUrl } from './pgClient'
import type { ParsedUrl } from './pgClient'
import { loadEnvFile, resetPool } from './pool'

function quoteIdent(ident: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(ident)) {
    throw new Error(`Unsafe SQL identifier: ${ident}`)
  }
  return `"${ident}"`
}

function resolveAdminUrl(target: ParsedUrl): string {
  const fromEnv = process.env.PG_ADMIN_URL?.trim()
  if (fromEnv) return fromEnv

  // Default: same host/port as DATABASE_URL, user postgres, database postgres
  return toDatabaseUrl({
    host: target.host,
    port: target.port,
    user: process.env.PG_ADMIN_USER?.trim() || 'postgres',
    password: process.env.PG_ADMIN_PASSWORD ?? '',
    database: 'postgres',
  })
}

/**
 * Create role + database from DATABASE_URL using a superuser connection.
 *
 * Env:
 *   DATABASE_URL     — target app DB (required), e.g. postgresql://finance:finance@localhost:5432/finance
 *   PG_ADMIN_URL     — optional admin URI, e.g. postgresql://postgres:secret@localhost:5432/postgres
 *   PG_ADMIN_USER / PG_ADMIN_PASSWORD — used only when PG_ADMIN_URL is unset
 */
export async function bootstrapDatabase(): Promise<void> {
  loadEnvFile()
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set')
  }

  const target = parseDatabaseUrl(databaseUrl)
  const adminUrl = resolveAdminUrl(target)
  const admin = new Pool(adminUrl)

  console.log(
    `Bootstrapping role=${target.user} database=${target.database} via ${parseDatabaseUrl(adminUrl).user}@${target.host}:${target.port}`,
  )

  const roleExists = await admin.query(
    `SELECT 1 AS ok FROM pg_roles WHERE rolname = $1`,
    [target.user],
  )
  if (roleExists.rows.length === 0) {
    if (!target.password) {
      await admin.query(`CREATE ROLE ${quoteIdent(target.user)} LOGIN`)
    } else {
      await admin.query(
        `CREATE ROLE ${quoteIdent(target.user)} LOGIN PASSWORD $1`,
        [target.password],
      )
    }
    console.log(`Created role ${target.user}`)
  } else {
    if (target.password) {
      await admin.query(`ALTER ROLE ${quoteIdent(target.user)} PASSWORD $1`, [target.password])
    }
    console.log(`Role ${target.user} already exists`)
  }

  const dbExists = await admin.query(
    `SELECT 1 AS ok FROM pg_database WHERE datname = $1`,
    [target.database],
  )
  if (dbExists.rows.length === 0) {
    await admin.query(
      `CREATE DATABASE ${quoteIdent(target.database)} OWNER ${quoteIdent(target.user)}`,
    )
    console.log(`Created database ${target.database}`)
  } else {
    console.log(`Database ${target.database} already exists`)
  }

  await admin.query(
    `GRANT ALL PRIVILEGES ON DATABASE ${quoteIdent(target.database)} TO ${quoteIdent(target.user)}`,
  )

  // Schema privileges inside the new DB (connect as admin to target DB)
  const adminOnDb = new Pool(
    toDatabaseUrl({
      ...parseDatabaseUrl(adminUrl),
      database: target.database,
    }),
  )
  await adminOnDb.query(`GRANT ALL ON SCHEMA public TO ${quoteIdent(target.user)}`)
  await adminOnDb.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${quoteIdent(target.user)}`,
  )
  await adminOnDb.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${quoteIdent(target.user)}`,
  )
  // pgcrypto is required for gen_random_uuid() on PG < 13; needs superuser.
  await adminOnDb.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`)

  resetPool()
  console.log('Bootstrap complete')
}
