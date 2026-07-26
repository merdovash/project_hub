import { hashPassword } from '../auth/password'
import { migrate } from './migrate'
import { getPool, loadEnvFile } from './pool'

const SEED_EMAIL = 'seed@local'
const SEED_PASSWORD = 'seed-not-for-login'

export async function seed(): Promise<void> {
  loadEnvFile()
  await migrate()
  const pool = getPool()
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE email = $1`,
    [SEED_EMAIL],
  )
  if (existing.rows[0]) {
    console.log(`Seed user ${SEED_EMAIL} already exists`)
    return
  }
  await pool.query(`INSERT INTO users (email, password_hash) VALUES ($1, $2)`, [
    SEED_EMAIL,
    hashPassword(SEED_PASSWORD),
  ])
  console.log(`Seeded user ${SEED_EMAIL}`)
}
