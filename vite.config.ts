/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { apiPlugin } from './vite-plugin-api'

function previewAllowedHosts(env: Record<string, string>): true | string[] {
  const cookie = env.COOKIE_DOMAIN?.trim()
  if (cookie) {
    return [cookie.startsWith('.') ? cookie : `.${cookie}`]
  }
  const domain = env.DOMAIN?.trim()
  if (domain) {
    return [`.${domain.replace(/^\./, '')}`]
  }
  return true
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), tailwindcss(), apiPlugin()],
    server: {
      host: true,
      watch: {
        ignored: [
          '**/dist/**',
          '**/logs/**',
          '**/deploy/**',
          '**/.git/**',
          '**/config/services.yaml',
        ],
      },
    },
    preview: {
      host: true,
      allowedHosts: previewAllowedHosts(env),
    },
    test: {
      globals: true,
      environment: 'node',
    },
  }
})
