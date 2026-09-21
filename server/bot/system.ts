/** System / PM2 / Postgres inspection and restart-deploy actions for the bot. */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getPool } from '../db/pool'
import { escapeHtml } from './telegram'

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60000)
  const days = Math.floor(totalMin / 1440)
  const hours = Math.floor((totalMin % 1440) / 60)
  const minutes = totalMin % 60
  if (days > 0) return `${days}д ${hours}ч`
  if (hours > 0) return `${hours}ч ${minutes}м`
  return `${minutes}м`
}

function sh(command: string, args: string[], timeoutMs = 30_000): { ok: boolean; out: string } {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  })
  const out = `${result.stdout || ''}${result.stderr || ''}`.trim()
  return { ok: result.status === 0, out }
}

interface Pm2Process {
  name?: string
  pm2_env?: { status?: string; restart_time?: number; pm_uptime?: number }
  monit?: { cpu?: number; memory?: number }
}

function pm2List(): Pm2Process[] {
  const result = sh('pm2', ['jlist'])
  if (!result.ok) return []
  try {
    // pm2 may prepend startup noise before the JSON array
    const start = result.out.indexOf('[')
    if (start < 0) return []
    return JSON.parse(result.out.slice(start)) as Pm2Process[]
  } catch {
    return []
  }
}

function memInfo(): { total: number; available: number } {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8')
    const get = (key: string): number => {
      const match = text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'))
      return match ? Number(match[1]) * 1024 : 0
    }
    const total = get('MemTotal')
    const available = get('MemAvailable')
    if (total > 0) return { total, available }
  } catch {
    /* non-linux fallback below */
  }
  return { total: os.totalmem(), available: os.freemem() }
}

function diskInfo(): string {
  const result = sh('df', ['-kP', '/'])
  if (!result.ok) return 'н/д'
  const lines = result.out.split('\n')
  const parts = (lines[1] ?? '').trim().split(/\s+/)
  if (parts.length < 5) return 'н/д'
  const total = Number(parts[1]) * 1024
  const used = Number(parts[2]) * 1024
  return `${formatBytes(used)} / ${formatBytes(total)} (${parts[4]})`
}

/** /status: host load, memory, disk and PM2 process table. */
export function getSystemStatus(): string {
  const load = os.loadavg()
  const cores = os.cpus().length || 1
  const mem = memInfo()
  const memUsed = mem.total - mem.available

  const lines: string[] = []
  lines.push(`<b>Сервер</b> (${escapeHtml(os.hostname())})`)
  lines.push(
    `CPU load: ${load.map((v) => v.toFixed(2)).join(' / ')} (1/5/15 мин, ядер: ${cores})`,
  )
  lines.push(
    `RAM: ${formatBytes(memUsed)} / ${formatBytes(mem.total)} (${Math.round((memUsed / mem.total) * 100)}%)`,
  )
  lines.push(`Диск /: ${diskInfo()}`)
  lines.push(`Uptime: ${formatDuration(os.uptime() * 1000)}`)
  lines.push('')

  const processes = pm2List()
  if (processes.length === 0) {
    lines.push('<b>PM2</b>: процессы не найдены (pm2 недоступен?)')
  } else {
    lines.push('<b>PM2 процессы</b>')
    for (const proc of processes) {
      const status = proc.pm2_env?.status ?? '?'
      const icon = status === 'online' ? '🟢' : '🔴'
      const cpu = proc.monit?.cpu ?? 0
      const memBytes = proc.monit?.memory ?? 0
      const uptime = proc.pm2_env?.pm_uptime ? formatDuration(Date.now() - proc.pm2_env.pm_uptime) : '?'
      const restarts = proc.pm2_env?.restart_time ?? 0
      lines.push(
        `${icon} <b>${escapeHtml(proc.name ?? '?')}</b> — ${status}, CPU ${cpu}%, RAM ${formatBytes(memBytes)}, uptime ${uptime}, рестартов ${restarts}`,
      )
    }
  }
  return lines.join('\n')
}

/** /db: current database size, top tables, all visible databases. */
export async function getDbStatus(): Promise<string> {
  const pool = getPool()
  const lines: string[] = []

  const current = await pool.query<{ db: string; size: number }>(
    'SELECT current_database() AS db, pg_database_size(current_database()) AS size',
  )
  const row = current.rows[0]
  if (row) {
    lines.push(`<b>БД ${escapeHtml(String(row.db))}</b>: ${formatBytes(Number(row.size))}`)
  }

  const tables = await pool.query<{ schema: string; name: string; size: number }>(
    `SELECT n.nspname AS schema, c.relname AS name, pg_total_relation_size(c.oid) AS size
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     ORDER BY size DESC LIMIT 10`,
  )
  if (tables.rows.length > 0) {
    lines.push('')
    lines.push('<b>Топ таблиц</b>')
    for (const table of tables.rows) {
      const prefix = table.schema === 'public' ? '' : `${escapeHtml(String(table.schema))}.`
      lines.push(`• ${prefix}${escapeHtml(String(table.name))} — ${formatBytes(Number(table.size))}`)
    }
  }

  try {
    const all = await pool.query<{ datname: string; size: number }>(
      `SELECT datname, pg_database_size(datname) AS size
       FROM pg_database WHERE NOT datistemplate ORDER BY size DESC`,
    )
    if (all.rows.length > 1) {
      lines.push('')
      lines.push('<b>Все базы</b>')
      for (const db of all.rows) {
        lines.push(`• ${escapeHtml(String(db.datname))} — ${formatBytes(Number(db.size))}`)
      }
    }
  } catch {
    /* нет прав на другие базы — не страшно */
  }

  return lines.join('\n')
}

/** Quick hub restart without rebuild: pm2 restart <portal>. */
export function restartHub(): { ok: boolean; out: string } {
  const appName = process.env.PM2_APP_NAME?.trim() || 'portal'
  return sh('pm2', ['restart', appName], 60_000)
}

export const DEPLOY_EXIT_MARKER = '__BOT_DEPLOY_EXIT:'

/**
 * Full redeploy (git pull + install + migrate + build + restart of hub and services).
 * Runs detached so it survives the bot's own PM2 restart during deploy.
 */
export function startDetachedDeploy(): { logFile: string } {
  const root = process.cwd()
  const logsDir = path.resolve(root, 'logs')
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const logFile = path.join(logsDir, `bot-deploy-${stamp}.log`)
  const script = path.join(root, 'scripts', 'deploy-all.sh')
  const child = spawn(
    'bash',
    [
      '-c',
      `cd '${root}' && bash '${script}' >> '${logFile}' 2>&1; echo "${DEPLOY_EXIT_MARKER}$?" >> '${logFile}'`,
    ],
    { detached: true, stdio: 'ignore' },
  )
  child.unref()
  return { logFile }
}

/** null while running; exit code once the marker is present. */
export function deployExitCode(logFile: string): number | null {
  try {
    if (!fs.existsSync(logFile)) return null
    const text = fs.readFileSync(logFile, 'utf8')
    const idx = text.lastIndexOf(DEPLOY_EXIT_MARKER)
    if (idx < 0) return null
    const match = text.slice(idx + DEPLOY_EXIT_MARKER.length).match(/^\d+/)
    return match ? Number(match[0]) : null
  } catch {
    return null
  }
}

export function tailFile(filePath: string, maxLines: number): string {
  try {
    if (!fs.existsSync(filePath)) return ''
    const text = fs.readFileSync(filePath, 'utf8')
    const lines = text.split('\n').filter((line) => !line.includes(DEPLOY_EXIT_MARKER))
    return lines.slice(-maxLines).join('\n').trim()
  } catch {
    return ''
  }
}

/** /logs: recent PM2 logs for a process. */
export function pm2Logs(name: string, lines: number): string {
  const safeLines = Math.min(Math.max(lines, 5), 100)
  const result = sh('pm2', ['logs', name, '--lines', String(safeLines), '--nostream'], 20_000)
  return result.out || '(пусто)'
}
