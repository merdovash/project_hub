import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { loadEnvFile } from '../db/pool'

export interface ServiceConfig {
  id: string
  name: string
  description: string
  subdomain: string
  repo: string
  branch: string
  path: string
  port: number
  pm2Name: string
  build: string
  start: string
  enabled: boolean
}

export interface PortalServicesConfig {
  domain: string
  cookieDomain: string
  portalPort: number
  services: ServiceConfig[]
}

export interface PublicService {
  id: string
  name: string
  description: string
  subdomain: string
  url: string
}

interface ServicesConfigCache {
  configPath: string
  mtimeMs: number
  value: PortalServicesConfig
}

let servicesConfigCache: ServicesConfigCache | null = null

function resolveConfigPath(): string {
  const fromEnv = process.env.SERVICES_CONFIG?.trim()
  if (fromEnv) return path.resolve(fromEnv)
  return path.resolve(process.cwd(), 'config', 'services.yaml')
}

function hostnameFromUrl(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined
  try {
    return new URL(raw.trim()).hostname || undefined
  } catch {
    return undefined
  }
}

/** DOMAIN → host of PORTAL_URL → COOKIE_DOMAIN → services.yaml */
export function resolveDomain(yamlDomain?: string): string {
  const fromEnv = process.env.DOMAIN?.trim()
  if (fromEnv) return fromEnv

  const fromPortal = hostnameFromUrl(process.env.PORTAL_URL)
  if (fromPortal) return fromPortal

  const cookie = process.env.COOKIE_DOMAIN?.trim()
  if (cookie) return cookie.replace(/^\./, '')

  if (yamlDomain?.trim()) return yamlDomain.trim()
  throw new Error('Set DOMAIN (or PORTAL_URL / COOKIE_DOMAIN) in .env, or domain in services.yaml')
}

export function resolveCookieDomain(domain: string, yamlCookie?: string): string {
  return process.env.COOKIE_DOMAIN?.trim() || yamlCookie?.trim() || `.${domain}`
}

export function resolvePublicProtocol(): string {
  const fromPortal = process.env.PORTAL_URL?.trim()
  if (fromPortal) {
    try {
      const proto = new URL(fromPortal).protocol.replace(':', '')
      if (proto === 'http' || proto === 'https') return proto
    } catch {
      /* fall through */
    }
  }
  const explicit = process.env.PUBLIC_PROTOCOL?.trim()
  if (explicit === 'http' || explicit === 'https') return explicit
  if (process.env.NODE_ENV === 'production') return 'https'
  if (process.env.DOMAIN?.trim() || process.env.COOKIE_DOMAIN?.trim()) return 'https'
  return 'http'
}

export function loadServicesConfig(): PortalServicesConfig {
  loadEnvFile()
  const configPath = resolveConfigPath()
  if (!fs.existsSync(configPath)) {
    throw new Error(`Services config not found: ${configPath}`)
  }
  const mtimeMs = fs.statSync(configPath).mtimeMs
  if (
    servicesConfigCache?.configPath === configPath &&
    servicesConfigCache.mtimeMs === mtimeMs
  ) {
    return servicesConfigCache.value
  }

  const raw = fs.readFileSync(configPath, 'utf8')
  const parsed = parseYaml(raw) as Partial<PortalServicesConfig>
  if (!Array.isArray(parsed.services)) {
    throw new Error('Invalid services.yaml: services[] required')
  }

  const domain = resolveDomain(parsed.domain)
  const cookieDomain = resolveCookieDomain(domain, parsed.cookieDomain)

  const services: ServiceConfig[] = parsed.services.map((svc) => ({
    id: String(svc.id),
    name: String(svc.name),
    description: String(svc.description ?? ''),
    subdomain: String(svc.subdomain),
    repo: String(svc.repo),
    branch: String(svc.branch ?? 'master'),
    path: String(svc.path),
    port: Number(svc.port),
    pm2Name: String(svc.pm2Name ?? svc.id),
    build: String(svc.build ?? 'npm ci && npm run build'),
    start: String(svc.start),
    enabled: svc.enabled !== false,
  }))

  const value = {
    domain,
    cookieDomain,
    portalPort: Number(parsed.portalPort ?? 5180),
    services,
  }
  servicesConfigCache = { configPath, mtimeMs, value }
  return value
}

export function resetServicesConfigCache(): void {
  servicesConfigCache = null
}

export function listPublicServices(cfg: PortalServicesConfig = loadServicesConfig()): PublicService[] {
  const protocol = resolvePublicProtocol()
  return cfg.services
    .filter((s) => s.enabled)
    .map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      subdomain: s.subdomain,
      url: `${protocol}://${s.subdomain}.${cfg.domain}`,
    }))
}
