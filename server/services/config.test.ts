import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadServicesConfig, resetServicesConfigCache } from './config'

const previousConfigPath = process.env.SERVICES_CONFIG
const previousDomain = process.env.DOMAIN
let tempDir: string | null = null

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function configYaml(description: string): string {
  return `
domain: example.test
portalPort: 5180
services:
  - id: finance
    name: Finance
    description: ${description}
    subdomain: finance
    repo: https://example.test/finance.git
    branch: master
    path: /srv/finance
    port: 5173
    pm2Name: finance
    build: npm run build
    start: npm run preview
    enabled: true
`
}

afterEach(() => {
  resetServicesConfigCache()
  restoreEnv('SERVICES_CONFIG', previousConfigPath)
  restoreEnv('DOMAIN', previousDomain)
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  tempDir = null
})

describe('loadServicesConfig', () => {
  it('reuses parsed YAML until the config file changes', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-services-'))
    tempDir = directory
    const configPath = path.join(directory, 'services.yaml')
    fs.writeFileSync(configPath, configYaml('first'))
    process.env.SERVICES_CONFIG = configPath
    process.env.DOMAIN = 'example.test'

    const first = loadServicesConfig()
    const cached = loadServicesConfig()

    expect(cached).toBe(first)
    expect(cached.services[0]?.description).toBe('first')

    fs.writeFileSync(configPath, configYaml('second'))
    const changedAt = new Date(Date.now() + 2_000)
    fs.utimesSync(configPath, changedAt, changedAt)

    const updated = loadServicesConfig()
    expect(updated).not.toBe(first)
    expect(updated.services[0]?.description).toBe('second')
  })
})
