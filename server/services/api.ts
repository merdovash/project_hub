import type { IncomingMessage, ServerResponse } from 'node:http'
import { listPublicServices, loadServicesConfig } from './config'

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

export async function handleServicesApi(
  _req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
): Promise<boolean> {
  if (pathname === '/api/services' && method === 'GET') {
    const cfg = loadServicesConfig()
    sendJson(res, 200, {
      domain: cfg.domain,
      services: listPublicServices(cfg),
    })
    return true
  }
  return false
}
