import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { loadEnvFile } from '../db/pool'

export interface ServiceEnv {
  [key: string]: string
}

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
  env?: ServiceEnv
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

function expandEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key: string) => process.env[key] ?? '')
}

function resolveConfigPath(): string {
  const fromEnv = process.env.SERVICES_CONFIG?.trim()
  if (fromEnv) return path.resolve(fromEnv)
  return path.resolve(process.cwd(), 'config', 'services.yaml')
}

export function loadServicesConfig(): PortalServicesConfig {
  loadEnvFile()
  const configPath = resolveConfigPath()
  if (!fs.existsSync(configPath)) {
    throw new Error(`Services config not found: ${configPath}`)
  }
  const raw = fs.readFileSync(configPath, 'utf8')
  const parsed = parseYaml(raw) as Partial<PortalServicesConfig>
  if (!parsed.domain || !Array.isArray(parsed.services)) {
    throw new Error('Invalid services.yaml: domain and services[] required')
  }

  const services: ServiceConfig[] = parsed.services.map((svc) => {
    const env: ServiceEnv = {}
    if (svc.env) {
      for (const [k, v] of Object.entries(svc.env)) {
        env[k] = expandEnv(String(v))
      }
    }
    return {
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
      env,
    }
  })

  return {
    domain: String(parsed.domain),
    cookieDomain: String(parsed.cookieDomain ?? `.${parsed.domain}`),
    portalPort: Number(parsed.portalPort ?? 5180),
    services,
  }
}

export function listPublicServices(cfg: PortalServicesConfig = loadServicesConfig()): PublicService[] {
  const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http'
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
