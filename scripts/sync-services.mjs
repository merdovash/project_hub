#!/usr/bin/env node
/**
 * Sync subservices from config/services.yaml:
 *   - generate + install Caddyfile
 *   - git clone/pull → npm ci → db:migrate → build → PM2 (unless --caddy-only)
 *   - copy shared env from portal .env into each service
 *
 * Per-service yaml keys: install, migrate, build (migrate: false to skip).
 *
 * Usage:
 *   node scripts/sync-services.mjs
 *   node scripts/sync-services.mjs --caddy-only
 *   node scripts/sync-services.mjs --only wallet
 *   node scripts/sync-services.mjs --force          # rebuild/restart even if git unchanged
 *   SERVICES_CONFIG=/etc/portal/services.yaml node scripts/sync-services.mjs
 *
 * Without --force: if origin HEAD не изменился и процесс уже отвечает — skip
 * install/migrate/build/PM2. При смене только .env или упавшем процессе — restart без rebuild.
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

function gitRev(cwd) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  return result.status === 0 ? String(result.stdout || '').trim() : ''
}

function ensureRepo(svc) {
  const branch = svc.branch || 'master'
  const gitDir = path.join(svc.path, '.git')
  if (!fs.existsSync(svc.path) || !fs.existsSync(gitDir)) {
    fs.mkdirSync(path.dirname(svc.path), { recursive: true })
    run('git', ['clone', '--branch', branch, svc.repo, svc.path])
    return { cloned: true, changed: true, sha: gitRev(svc.path) }
  }

  const before = gitRev(svc.path)
  run('git', ['fetch', 'origin', branch], { cwd: svc.path })
  run('git', ['checkout', branch], { cwd: svc.path })
  run('git', ['reset', '--hard', `origin/${branch}`], { cwd: svc.path })
  const after = gitRev(svc.path)
  return { cloned: false, changed: !before || before !== after, sha: after }
}

function writeServiceEnv(svc, sharedEnv) {
  const lines = [`# Generated by portal sync for ${svc.id} (from hub .env)`]
  for (const [k, v] of Object.entries(sharedEnv)) {
    lines.push(`${k}=${v}`)
  }
  const content = `${lines.join('\n')}\n`
  const envPath = path.join(svc.path, '.env')
  const prev = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : null
  fs.writeFileSync(envPath, content)
  return prev !== content
}

function pm2IsOnline(name) {
  const result = spawnSync('pm2', ['jlist'], {
    encoding: 'utf8',
    shell: true,
  })
  if (result.status !== 0) return false
  try {
    const list = JSON.parse(String(result.stdout || '[]'))
    return list.some((p) => p.name === name && p.pm2_env?.status === 'online')
  } catch {
    return false
  }
}

function localPortResponds(port) {
  const result = spawnSync(
    'curl',
    ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--connect-timeout', '1', `http://127.0.0.1:${port}/`],
    { encoding: 'utf8', shell: process.platform === 'win32' },
  )
  const code = String(result.stdout || '').trim()
  return /^\d+$/.test(code) && code !== '000'
}

function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const end = Date.now() + ms
    while (Date.now() < end) {
      /* fallback busy wait */
    }
  }
}

function packageHasScript(cwd, scriptName) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'))
    return Boolean(pkg.scripts?.[scriptName])
  } catch {
    return false
  }
}

/** Strip legacy `npm ci &&` prefix from build when install runs separately. */
function resolveBuildCommand(svc) {
  let build = (svc.build && String(svc.build).trim()) || 'npm run build'
  build = build.replace(/^npm\s+ci\s*&&\s*/i, '').trim()
  return build || 'npm run build'
}

function resolveMigrateCommand(svc) {
  if (svc.migrate === false || svc.migrate === null) return null
  if (typeof svc.migrate === 'string' && svc.migrate.trim()) return svc.migrate.trim()
  if (packageHasScript(svc.path, 'db:migrate')) return 'npm run db:migrate'
  return null
}

/** Vite has no CLI `--allowed-hosts` for preview; use env (picked up via server.allowedHosts). */
function allowedHostsEnv(domain) {
  const host = String(domain || '')
    .trim()
    .replace(/^\./, '')
  return host ? `.${host}` : ''
}

function waitForLocalPort(port, label, attempts = 45) {
  for (let i = 0; i < attempts; i++) {
    const result = spawnSync(
      'curl',
      ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '--connect-timeout', '1', `http://127.0.0.1:${port}/`],
      { encoding: 'utf8', shell: process.platform === 'win32' },
    )
    const code = String(result.stdout || '').trim()
    if (/^\d+$/.test(code) && code !== '000') {
      console.log(`==> ${label} ready on :${port} (HTTP ${code})`)
      return
    }
    sleepMs(1000)
  }
  throw new Error(`${label} did not become ready on 127.0.0.1:${port}`)
}

function restartPm2(svc, domain) {
  const name = svc.pm2Name || svc.id
  const allowed = allowedHostsEnv(domain)
  spawnSync('pm2', ['delete', name], { stdio: 'ignore', shell: true })
  const env = { ...process.env }
  if (allowed) {
    env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = allowed
  }
  run(
    'pm2',
    [
      'start',
      'npm',
      '--name',
      name,
      '--cwd',
      svc.path,
      '--',
      'run',
      'preview',
      '--',
      '--host',
      '127.0.0.1',
      '--port',
      String(svc.port),
    ],
    { cwd: svc.path, env },
  )
  run('pm2', ['save'], {})
  waitForLocalPort(svc.port, name)
}

function syncService(svc, sharedEnv, domain, { force = false } = {}) {
  const name = svc.pm2Name || svc.id
  console.log(`\n==> Sync ${svc.id} (${svc.subdomain})`)
  const repo = ensureRepo(svc)
  const envChanged = writeServiceEnv(svc, sharedEnv)
  const shaShort = repo.sha ? repo.sha.slice(0, 7) : '?'
  console.log(
    `==> Git ${svc.id}: ${repo.cloned ? 'cloned' : repo.changed ? 'updated' : 'unchanged'} (${shaShort})`,
  )

  if (!sharedEnv.DATABASE_URL?.trim()) {
    throw new Error(`DATABASE_URL missing — required for ${svc.id} migrate/runtime`)
  }

  const healthy = pm2IsOnline(name) && localPortResponds(svc.port)
  const needsFull = force || repo.cloned || repo.changed
  const needsRestart = needsFull || envChanged || !healthy

  if (!needsFull && !needsRestart) {
    console.log(`==> ${svc.id}: no git/env changes and ${name} is healthy — skip rebuild/restart`)
    return
  }

  if (!needsFull && needsRestart) {
    const reason = envChanged ? 'env changed' : `${name} not healthy`
    console.log(`==> ${svc.id}: ${reason} — restart only (no rebuild)`)
    restartPm2(svc, domain)
    return
  }

  const env = buildEnv(sharedEnv)
  const install = (svc.install && String(svc.install).trim()) || 'npm ci'
  console.log(`==> Install ${svc.id}`)
  runShell(install, svc.path, env)

  const migrate = resolveMigrateCommand(svc)
  if (migrate) {
    console.log(`==> Migrate ${svc.id}`)
    runShell(migrate, svc.path, env)
  } else {
    console.log(`==> Migrate ${svc.id}: skipped (no db:migrate / migrate: false)`)
  }

  console.log(`==> Build ${svc.id}`)
  runShell(resolveBuildCommand(svc), svc.path, env)
  restartPm2(svc, domain)
}

function maybeReloadCaddy(caddyPath) {
  const reloadCmd = process.env.CADDY_RELOAD
  if (reloadCmd) {
    runShell(reloadCmd, ROOT, {})
    return
  }
  const caddyfile = process.env.CADDYFILE || caddyPath
  const probe = spawnSync('caddy', ['version'], { stdio: 'ignore', shell: true })
  if (probe.status === 0 && fs.existsSync(caddyfile)) {
    run('caddy', ['reload', '--config', caddyfile], {})
  } else {
    console.log(`Caddyfile written to ${caddyPath} (reload manually or set CADDY_RELOAD)`)
  }
}

/** Prefer system unit config; fall back to reload with generated path. */
function installCaddyfile(caddyPath) {
  const dest = process.env.CADDYFILE_DEST || '/etc/caddy/Caddyfile'
  if (fs.existsSync(path.dirname(dest))) {
    try {
      fs.copyFileSync(caddyPath, dest)
      console.log(`Installed Caddyfile → ${dest}`)
      const reload = spawnSync('systemctl', ['reload', 'caddy'], { stdio: 'inherit' })
      if (reload.status === 0) return
      console.warn('systemctl reload caddy failed; trying caddy reload')
    } catch (err) {
      console.warn(`Could not install Caddyfile to ${dest}: ${err.message}`)
    }
  }
  maybeReloadCaddy(caddyPath)
}

function main() {
  const args = process.argv.slice(2)
  const caddyOnly = args.includes('--caddy-only')
  const force = args.includes('--force')
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

  installCaddyfile(caddyPath)

  if (caddyOnly) {
    console.log('Caddy-only sync done')
    return
  }

  const targets = cfg.services.filter((s) => s.enabled && (!onlyId || s.id === onlyId))
  if (onlyId && targets.length === 0) {
    throw new Error(`Service not found or disabled: ${onlyId}`)
  }
  for (const svc of targets) {
    syncService(svc, sharedEnv, cfg.domain, { force })
  }
  console.log(force ? '\nSync complete (--force)' : '\nSync complete')
}

main()
