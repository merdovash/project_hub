#!/usr/bin/env node
/**
 * Sync subservices from config/services.yaml:
 *   - generate Caddyfile
 *   - git clone/pull + build + PM2 restart (unless --caddy-only)
 *   - copy shared env from portal .env into each service
 *
 * Usage:
 *   node scripts/sync-services.mjs
 *   node scripts/sync-services.mjs --caddy-only
 *   node scripts/sync-services.mjs --only wallet
 *   SERVICES_CONFIG=/etc/portal/services.yaml node scripts/sync-services.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

/** Hub-only keys — not copied into child services */
const HUB_ONLY_ENV = new Set([
  'PG_ADMIN_URL',
  'PG_ADMIN_USER',
  'PG_ADMIN_PASSWORD',
  'SERVICES_CONFIG',
  'PORTAL_UPSTREAM_HOST',
  'CADDY_RELOAD',
  'CADDYFILE',
])

function parseEnvFile(filePath) {
  const out = {}
  if (!fs.existsSync(filePath)) return out
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
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
    out[key] = value
  }
  return out
}

function loadEnvFile() {
  for (const [key, value] of Object.entries(parseEnvFile(path.join(ROOT, '.env')))) {
    if (process.env[key] === undefined) process.env[key] = value
  }
}

/** Minimal YAML parser for services.yaml (top-level scalars + services list of maps). No deps. */
function parseServicesYaml(text) {
  const root = {}
  let services = null
  let current = null

  const coerce = (raw) => {
    if (raw === 'true') return true
    if (raw === 'false') return false
    if (raw === '' || raw === '~' || raw === 'null') return null
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
    if (
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
    ) {
      return raw.slice(1, -1)
    }
    return raw
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue

    const listItem = line.match(/^(\s*)-\s+([A-Za-z_][\w]*)\s*:\s*(.*)$/)
    if (listItem) {
      if (!services) throw new Error('Unexpected list item before services:')
      current = { [listItem[2]]: coerce(listItem[3].trim()) }
      services.push(current)
      continue
    }

    const nested = line.match(/^\s{2,}([A-Za-z_][\w]*)\s*:\s*(.*)$/)
    if (nested && current) {
      current[nested[1]] = coerce(nested[2].trim())
      continue
    }

    const top = line.match(/^([A-Za-z_][\w]*)\s*:\s*(.*)$/)
    if (!top) continue
    const key = top[1]
    const rest = top[2].trim()
    if (key === 'services' && rest === '') {
      services = []
      root.services = services
      current = null
      continue
    }
    root[key] = coerce(rest)
  }

  return root
}

function loadConfig() {
  loadEnvFile()
  const configPath = process.env.SERVICES_CONFIG?.trim()
    ? path.resolve(process.env.SERVICES_CONFIG.trim())
    : path.join(ROOT, 'config', 'services.yaml')
  const parsed = parseServicesYaml(fs.readFileSync(configPath, 'utf8'))
  if (!Array.isArray(parsed.services)) {
    throw new Error(`Invalid services config: ${configPath}`)
  }

  const domain =
    process.env.DOMAIN?.trim() ||
    (() => {
      try {
        return process.env.PORTAL_URL?.trim() ? new URL(process.env.PORTAL_URL.trim()).hostname : ''
      } catch {
        return ''
      }
    })() ||
    process.env.COOKIE_DOMAIN?.trim()?.replace(/^\./, '') ||
    parsed.domain

  if (!domain) {
    throw new Error('Set DOMAIN (or PORTAL_URL / COOKIE_DOMAIN) in .env, or domain in services.yaml')
  }

  const cookieDomain =
    process.env.COOKIE_DOMAIN?.trim() || parsed.cookieDomain || `.${domain}`

  return {
    domain,
    cookieDomain,
    portalPort: Number(parsed.portalPort ?? 5180),
    portalHost: process.env.PORTAL_UPSTREAM_HOST ?? '127.0.0.1',
    services: parsed.services.map((svc) => ({
      ...svc,
      enabled: svc.enabled !== false,
    })),
    configPath,
  }
}

/** Shared env for child services: hub .env minus hub-only keys, plus derived defaults */
function sharedEnvForServices(cfg) {
  const hubFile = parseEnvFile(path.join(ROOT, '.env'))
  const env = {}

  for (const [key, value] of Object.entries(hubFile)) {
    if (HUB_ONLY_ENV.has(key)) continue
    env[key] = value
  }

  // Prefer live process.env when set (CI / shell overrides)
  for (const key of Object.keys(env)) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  if (process.env.DATABASE_URL && !env.DATABASE_URL) {
    env.DATABASE_URL = process.env.DATABASE_URL
  }

  const portalUrl = env.PORTAL_URL?.trim() || `https://${cfg.domain}`
  env.COOKIE_DOMAIN = env.COOKIE_DOMAIN?.trim() || cfg.cookieDomain
  env.PORTAL_URL = portalUrl
  env.VITE_PORTAL_URL = env.VITE_PORTAL_URL?.trim() || portalUrl
  env.NODE_ENV = 'production'

  return env
}

function renderCaddyfile(cfg) {
  const lines = []
  lines.push(`# Generated by portal sync — do not edit by hand`)
  lines.push(`# source: ${cfg.configPath}`)
  lines.push('')
  lines.push(`${cfg.domain} {`)
  lines.push(`\treverse_proxy ${cfg.portalHost}:${cfg.portalPort}`)
  lines.push(`}`)
  lines.push('')
  for (const svc of cfg.services.filter((s) => s.enabled)) {
    lines.push(`${svc.subdomain}.${cfg.domain} {`)
    lines.push(`\treverse_proxy 127.0.0.1:${svc.port}`)
    lines.push(`}`)
    lines.push('')
  }
  return lines.join('\n')
}

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  })
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${cmd} ${args.join(' ')}`)
  }
}

function runShell(command, cwd, env) {
  console.log(`$ (${cwd}) ${command}`)
  const result = spawnSync(command, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: true,
  })
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${command}`)
  }
}

/** Env for install/build: keep shared vars, but unset NODE_ENV so npm ci installs devDependencies. */
function buildEnv(sharedEnv) {
  const { NODE_ENV: _ignored, ...rest } = sharedEnv
  // Explicit empty overrides process.env.NODE_ENV after merge in runShell
  return { ...rest, NODE_ENV: '' }
}

function ensureRepo(svc) {
  if (!fs.existsSync(svc.path)) {
    fs.mkdirSync(path.dirname(svc.path), { recursive: true })
    run('git', ['clone', '--branch', svc.branch || 'master', svc.repo, svc.path])
    return
  }
  run('git', ['fetch', 'origin', svc.branch || 'master'], { cwd: svc.path })
  run('git', ['checkout', svc.branch || 'master'], { cwd: svc.path })
  run('git', ['reset', '--hard', `origin/${svc.branch || 'master'}`], { cwd: svc.path })
}

function writeServiceEnv(svc, sharedEnv) {
  const lines = [`# Generated by portal sync for ${svc.id} (from hub .env)`]
  for (const [k, v] of Object.entries(sharedEnv)) {
    lines.push(`${k}=${v}`)
  }
  fs.writeFileSync(path.join(svc.path, '.env'), `${lines.join('\n')}\n`, 'utf8')
}

function restartPm2(svc) {
  const name = svc.pm2Name || svc.id
  spawnSync('pm2', ['delete', name], { stdio: 'ignore', shell: true })
  // Prefer start via npm script string from config
  run('pm2', [
    'start',
    'npm',
    '--name',
    name,
    '--',
    'run',
    'preview',
    '--',
    '--host',
    '127.0.0.1',
    '--port',
    String(svc.port),
  ], { cwd: svc.path })
  run('pm2', ['save'], {})
}

function syncService(svc, sharedEnv) {
  console.log(`\n==> Sync ${svc.id} (${svc.subdomain})`)
  ensureRepo(svc)
  writeServiceEnv(svc, sharedEnv)
  runShell(svc.build || 'npm ci && npm run build', svc.path, buildEnv(sharedEnv))
  restartPm2(svc)
}

function maybeReloadCaddy(caddyPath) {
  const reloadCmd = process.env.CADDY_RELOAD
  if (reloadCmd) {
    runShell(reloadCmd, ROOT, {})
    return
  }
  // Best-effort: caddy reload if binary exists and Caddyfile path is set
  const caddyfile = process.env.CADDYFILE || caddyPath
  const probe = spawnSync('caddy', ['version'], { stdio: 'ignore', shell: true })
  if (probe.status === 0 && fs.existsSync(caddyfile)) {
    run('caddy', ['reload', '--config', caddyfile], {})
  } else {
    console.log(`Caddyfile written to ${caddyPath} (reload manually or set CADDY_RELOAD)`)
  }
}

function main() {
  const args = process.argv.slice(2)
  const caddyOnly = args.includes('--caddy-only')
  const onlyIdx = args.indexOf('--only')
  const onlyId = onlyIdx >= 0 ? args[onlyIdx + 1] : null

  const cfg = loadConfig()
  const sharedEnv = sharedEnvForServices(cfg)
  const outDir = path.join(ROOT, 'deploy')
  fs.mkdirSync(outDir, { recursive: true })
  const caddyPath = path.join(outDir, 'Caddyfile.generated')
  fs.writeFileSync(caddyPath, renderCaddyfile(cfg), 'utf8')
  console.log(`Wrote ${caddyPath}`)

  // Also emit a DNS/wildcard checklist
  const dnsPath = path.join(outDir, 'DNS.md')
  fs.writeFileSync(
    dnsPath,
    [
      `# DNS for ${cfg.domain}`,
      '',
      `Point these records to your VPS:`,
      '',
      `- \`A\` (or \`AAAA\`) \`${cfg.domain}\` → VPS IP`,
      `- \`A\` (or \`AAAA\`) \`*.${cfg.domain}\` → VPS IP (wildcard for subservices)`,
      '',
      `Enabled services:`,
      ...cfg.services.filter((s) => s.enabled).map((s) => `- ${s.subdomain}.${cfg.domain} → 127.0.0.1:${s.port}`),
      '',
      `Portal: ${cfg.domain} → 127.0.0.1:${cfg.portalPort}`,
      '',
    ].join('\n'),
    'utf8',
  )

  maybeReloadCaddy(caddyPath)

  if (caddyOnly) {
    console.log('Caddy-only sync done')
    return
  }

  const targets = cfg.services.filter((s) => s.enabled && (!onlyId || s.id === onlyId))
  if (onlyId && targets.length === 0) {
    throw new Error(`Service not found or disabled: ${onlyId}`)
  }
  for (const svc of targets) {
    syncService(svc, sharedEnv)
  }
  console.log('\nSync complete')
}

main()
