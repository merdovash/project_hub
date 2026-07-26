import type { Plugin } from 'vite'
import { handleAuthApi } from './server/auth/api'
import { loadEnvFile } from './server/db/pool'
import { logServerError, publicErrorMessage } from './server/logger'
import { handleServicesApi } from './server/services/api'

function apiMiddleware() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (req: any, res: any, next: () => void) => {
    if (!req.url?.startsWith('/api/')) {
      next()
      return
    }

    const url = new URL(req.url, 'http://localhost')
    const pathname = url.pathname
    const method = req.method ?? 'GET'

    const run = async () => {
      if (pathname.startsWith('/api/auth')) {
        return handleAuthApi(req, res, pathname)
      }
      if (pathname.startsWith('/api/services')) {
        return handleServicesApi(req, res, pathname, method)
      }
      return false
    }

    run()
      .then((handled) => {
        if (!handled) {
          res.statusCode = 404
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: 'Not found' }))
        }
      })
      .catch((err: unknown) => {
        logServerError(`${method} ${pathname}`, err)
        const { status, error } = publicErrorMessage(err)
        res.statusCode = status
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error }))
      })
  }
}

export function apiPlugin(): Plugin {
  return {
    name: 'portal-api',
    configureServer(server) {
      loadEnvFile()
      server.middlewares.use(apiMiddleware())
    },
    configurePreviewServer(server) {
      loadEnvFile()
      server.middlewares.use(apiMiddleware())
    },
  }
}
