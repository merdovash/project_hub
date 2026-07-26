import { createHash } from 'node:crypto'
import net from 'node:net'
import type { Socket } from 'node:net'

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[]
  rowCount: number
}

export interface ParsedUrl {
  host: string
  port: number
  user: string
  password: string
  database: string
}

export function parseDatabaseUrl(url: string): ParsedUrl {
  const parsed = new URL(url)
  return {
    host: parsed.hostname || 'localhost',
    port: Number(parsed.port || 5432),
    user: decodeURIComponent(parsed.username || 'postgres'),
    password: decodeURIComponent(parsed.password || ''),
    database: decodeURIComponent((parsed.pathname || '/postgres').replace(/^\//, '') || 'postgres'),
  }
}

export function toDatabaseUrl(auth: ParsedUrl): string {
  const user = encodeURIComponent(auth.user)
  const password = auth.password ? `:${encodeURIComponent(auth.password)}` : ''
  return `postgresql://${user}${password}@${auth.host}:${auth.port}/${encodeURIComponent(auth.database)}`
}

function writeInt32(buf: Buffer, offset: number, value: number): void {
  buf.writeInt32BE(value, offset)
}

function startupMessage(user: string, database: string): Buffer {
  const params = `user\0${user}\0database\0${database}\0\0`
  const body = Buffer.from(params, 'utf8')
  const buf = Buffer.alloc(8 + body.length)
  writeInt32(buf, 0, buf.length)
  writeInt32(buf, 4, 196608)
  body.copy(buf, 8)
  return buf
}

function passwordMessage(password: string): Buffer {
  const body = Buffer.from(`${password}\0`, 'utf8')
  const buf = Buffer.alloc(5 + body.length)
  buf[0] = 0x70
  writeInt32(buf, 1, 4 + body.length)
  body.copy(buf, 5)
  return buf
}

/** Postgres AuthenticationMD5Password response: md5(md5(password+user)+salt). */
export function md5PasswordResponse(user: string, password: string, salt: Buffer): string {
  const inner = createHash('md5').update(password + user, 'utf8').digest('hex')
  const outer = createHash('md5').update(inner, 'utf8').update(salt).digest('hex')
  return `md5${outer}`
}

function queryMessage(sql: string): Buffer {
  const body = Buffer.from(`${sql}\0`, 'utf8')
  const buf = Buffer.alloc(5 + body.length)
  buf[0] = 0x51
  writeInt32(buf, 1, 4 + body.length)
  body.copy(buf, 5)
  return buf
}

function terminateMessage(): Buffer {
  const buf = Buffer.alloc(5)
  buf[0] = 0x58
  writeInt32(buf, 1, 4)
  return buf
}

function readCString(buf: Buffer, offset: number): { value: string; next: number } {
  let end = offset
  while (end < buf.length && buf[end] !== 0) end += 1
  return { value: buf.subarray(offset, end).toString('utf8'), next: end + 1 }
}

function escapeLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** Bind `$1..$n` placeholders with SQL literals. */
export function formatSql(sql: string, params: unknown[]): string {
  return sql.replace(/\$(\d+)/g, (_, n: string) => {
    const param = params[Number(n) - 1]
    if (param === null || param === undefined) return 'NULL'
    if (typeof param === 'number') {
      if (!Number.isFinite(param)) throw new Error('Invalid number parameter')
      return String(param)
    }
    if (typeof param === 'boolean') return param ? 'TRUE' : 'FALSE'
    if (param instanceof Date) return escapeLiteral(param.toISOString())
    if (typeof param === 'object') return `${escapeLiteral(JSON.stringify(param))}::jsonb`
    return escapeLiteral(String(param))
  })
}

function parseError(body: Buffer): Error {
  let offset = 0
  let message = 'Postgres error'
  while (offset < body.length) {
    const field = body[offset]
    if (field === 0) break
    offset += 1
    const str = readCString(body, offset)
    offset = str.next
    if (String.fromCharCode(field!) === 'M') message = str.value
  }
  return new Error(message)
}

function coerceValue(raw: string): unknown {
  if (raw === 't') return true
  if (raw === 'f') return false
  if (/^-?\d+$/.test(raw)) {
    const n = Number(raw)
    if (Number.isSafeInteger(n)) return n
  }
  if (/^-?\d+\.\d+$/.test(raw)) {
    const n = Number(raw)
    if (Number.isFinite(n)) return n
  }
  if (
    (raw.startsWith('{') && raw.endsWith('}')) ||
    (raw.startsWith('[') && raw.endsWith(']'))
  ) {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  // ISO timestamps from Postgres
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw
  return raw
}

class PgConnection {
  private socket: Socket
  private buffer = Buffer.alloc(0)
  private auth: ParsedUrl
  private connected = false
  private pending: {
    resolve: (result: QueryResult) => void
    reject: (err: Error) => void
    fields: string[]
    rows: Record<string, unknown>[]
    rowCount: number
  } | null = null
  private connectResolve: (() => void) | null = null
  private connectReject: ((err: Error) => void) | null = null

  constructor(auth: ParsedUrl) {
    this.auth = auth
    this.socket = net.connect({ host: auth.host, port: auth.port })
    this.socket.on('data', (chunk) => this.onData(chunk))
    this.socket.on('error', (err) => {
      this.pending?.reject(err)
      this.pending = null
      this.connectReject?.(err)
      this.connectResolve = null
      this.connectReject = null
    })
    this.socket.on('close', () => {
      if (this.pending) {
        this.pending.reject(new Error('Connection closed'))
        this.pending = null
      }
    })
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.connectResolve = resolve
      this.connectReject = reject
      this.socket.once('connect', () => {
        this.socket.write(startupMessage(this.auth.user, this.auth.database))
      })
    })
  }

  query(sql: string): Promise<QueryResult> {
    if (!this.connected) return Promise.reject(new Error('Not connected'))
    if (this.pending) return Promise.reject(new Error('Query already in progress'))

    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, fields: [], rows: [], rowCount: 0 }
      this.socket.write(queryMessage(sql))
    })
  }

  end(): void {
    try {
      this.socket.write(terminateMessage())
    } catch {
      /* ignore */
    }
    this.socket.end()
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 5) {
      const length = this.buffer.readInt32BE(1)
      const total = 1 + length
      if (this.buffer.length < total) return
      const type = String.fromCharCode(this.buffer[0]!)
      const body = this.buffer.subarray(5, total)
      this.buffer = this.buffer.subarray(total)
      this.handleMessage(type, body)
    }
  }

  private handleMessage(type: string, body: Buffer): void {
    switch (type) {
      case 'R': {
        const authType = body.readInt32BE(0)
        if (authType === 0) return
        // AuthenticationCleartextPassword
        if (authType === 3) {
          this.socket.write(passwordMessage(this.auth.password))
          return
        }
        // AuthenticationMD5Password (4-byte salt follows)
        if (authType === 5) {
          if (body.length < 8) {
            const err = new Error('Malformed MD5 auth challenge from Postgres')
            this.connectReject?.(err)
            this.connectResolve = null
            this.connectReject = null
            this.socket.destroy()
            return
          }
          const salt = body.subarray(4, 8)
          const token = md5PasswordResponse(this.auth.user, this.auth.password, salt)
          this.socket.write(passwordMessage(token))
          return
        }
        const hint =
          authType === 10
            ? ' Server uses SCRAM-SHA-256; set pg_hba.conf to md5 for 127.0.0.1 or use trust for local bootstrap.'
            : ' Configure password (cleartext/md5) or trust auth in pg_hba.conf.'
        const err = new Error(`Unsupported Postgres auth type ${authType}.${hint}`)
        this.connectReject?.(err)
        this.connectResolve = null
        this.connectReject = null
        this.socket.destroy()
        return
      }
      case 'E': {
        const err = parseError(body)
        if (this.pending) {
          this.pending.reject(err)
          this.pending = null
          return
        }
        this.connectReject?.(err)
        this.connectResolve = null
        this.connectReject = null
        return
      }
      case 'Z': {
        if (!this.connected) {
          this.connected = true
          this.connectResolve?.()
          this.connectResolve = null
          this.connectReject = null
          return
        }
        if (this.pending) {
          const result = { rows: this.pending.rows, rowCount: this.pending.rowCount }
          const { resolve } = this.pending
          this.pending = null
          resolve(result)
        }
        return
      }
      case 'T': {
        if (!this.pending) return
        const fieldCount = body.readInt16BE(0)
        let offset = 2
        const fields: string[] = []
        for (let i = 0; i < fieldCount; i += 1) {
          const name = readCString(body, offset)
          offset = name.next + 18
          fields.push(name.value)
        }
        this.pending.fields = fields
        return
      }
      case 'D': {
        if (!this.pending) return
        const colCount = body.readInt16BE(0)
        let offset = 2
        const row: Record<string, unknown> = {}
        for (let i = 0; i < colCount; i += 1) {
          const len = body.readInt32BE(offset)
          offset += 4
          const name = this.pending.fields[i] ?? `col${i}`
          if (len === -1) {
            row[name] = null
          } else {
            const raw = body.subarray(offset, offset + len).toString('utf8')
            offset += len
            row[name] = coerceValue(raw)
          }
        }
        this.pending.rows.push(row)
        return
      }
      case 'C': {
        if (!this.pending) return
        const tag = readCString(body, 0).value
        const match = tag.match(/ (\d+)$/)
        this.pending.rowCount = match ? Number(match[1]) : this.pending.rows.length
        return
      }
      default:
        return
    }
  }
}

export type SqlQuery = <T = Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<QueryResult<T>>

/** Lightweight pool: one short-lived connection per query (no npm `pg` dependency). */
export class Pool {
  private url: string

  constructor(connectionString?: string) {
    this.url = connectionString ?? process.env.DATABASE_URL ?? ''
    if (!this.url) {
      throw new Error('DATABASE_URL is not set')
    }
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.withConnection((query) => query<T>(sql, params))
  }

  /** Run multiple queries on one connection (for transactions). */
  async withConnection<T>(fn: (query: SqlQuery) => Promise<T>): Promise<T> {
    const auth = parseDatabaseUrl(this.url)
    const conn = new PgConnection(auth)
    await conn.connect()
    const query: SqlQuery = async <R = Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
    ) => {
      const result = await conn.query(formatSql(sql, params))
      return result as QueryResult<R>
    }
    try {
      return await fn(query)
    } finally {
      conn.end()
    }
  }

  async transaction<T>(fn: (query: SqlQuery) => Promise<T>): Promise<T> {
    return this.withConnection(async (query) => {
      await query('BEGIN')
      try {
        const result = await fn(query)
        await query('COMMIT')
        return result
      } catch (err) {
        try {
          await query('ROLLBACK')
        } catch {
          /* ignore rollback errors */
        }
        throw err
      }
    })
  }
}
