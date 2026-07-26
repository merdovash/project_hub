declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf-8' | 'utf8'): string
  export function writeFileSync(path: string, data: string, encoding?: 'utf-8' | 'utf8'): void
  export function existsSync(path: string): boolean
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void
  export function copyFileSync(src: string, dest: string): void
  export function unlinkSync(path: string): void
  export function appendFileSync(path: string, data: string, encoding?: 'utf-8' | 'utf8'): void
  export function readdirSync(path: string): string[]
}

declare module 'node:path' {
  export function resolve(...paths: string[]): string
  export function join(...paths: string[]): string
  export function dirname(path: string): string
}

declare module 'node:crypto' {
  export function randomUUID(): string
  export function randomBytes(size: number): BufferInstance
  export function createHash(algorithm: string): {
    update(data: string | BufferInstance, encoding?: string): {
      update(data: string | BufferInstance, encoding?: string): {
        digest(encoding: 'hex'): string
      }
      digest(encoding: 'hex'): string
    }
    digest(encoding: 'hex'): string
  }
  export function scryptSync(
    password: string,
    salt: BufferInstance,
    keylen: number,
    options?: { N: number; r: number; p: number },
  ): BufferInstance
  export function timingSafeEqual(a: BufferInstance, b: BufferInstance): boolean
}

declare module 'node:os' {
  export function tmpdir(): string
}

declare module 'node:http' {
  export interface IncomingMessage {
    method?: string
    url?: string
    headers: { cookie?: string; [key: string]: string | string[] | undefined }
    on(event: 'data', listener: (chunk: Uint8Array | string) => void): void
    on(event: 'end' | 'error', listener: () => void): void
    [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array | string>
  }
  export interface ServerResponse {
    statusCode: number
    setHeader(name: string, value: string): void
    end(chunk?: string): void
  }
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string
}

declare module 'node:net' {
  export interface Socket {
    write(data: BufferInstance | string): boolean
    end(): void
    destroy(): void
    on(event: 'data', listener: (chunk: BufferInstance) => void): void
    on(event: 'error', listener: (err: Error) => void): void
    on(event: 'close', listener: () => void): void
    once(event: 'connect' | 'error', listener: (...args: unknown[]) => void): void
    off(event: 'error', listener: (...args: unknown[]) => void): void
  }
  export function connect(options: { host: string; port: number }): Socket
  const net: { connect: typeof connect; Socket: Socket }
  export default net
  export type { Socket as NetSocket }
}

declare module 'node:events' {
  export class EventEmitter {
    on(event: string, listener: (...args: unknown[]) => void): this
    once(event: string, listener: (...args: unknown[]) => void): this
    emit(event: string, ...args: unknown[]): boolean
    off(event: string, listener: (...args: unknown[]) => void): this
  }
}

declare const process: {
  cwd(): string
  env: Record<string, string | undefined>
  argv: string[]
  exit(code?: number): never
}

interface BufferInstance extends Uint8Array {
  toString(encoding?: 'utf-8' | 'utf8' | 'hex'): string
  copy(target: Uint8Array, targetStart?: number, sourceStart?: number, sourceEnd?: number): number
  writeInt32BE(value: number, offset?: number): number
  readInt32BE(offset?: number): number
  readInt16BE(offset?: number): number
  subarray(start?: number, end?: number): BufferInstance
}

interface BufferConstructor {
  alloc(size: number): BufferInstance
  concat(buffers: Uint8Array[]): BufferInstance
  from(data: string | Uint8Array, encoding?: 'utf-8' | 'utf8' | 'hex'): BufferInstance
}

declare const Buffer: BufferConstructor
type Buffer = BufferInstance

declare function structuredClone<T>(value: T): T

declare class URL {
  constructor(input: string, base?: string)
  hostname: string
  port: string
  username: string
  password: string
  pathname: string
  searchParams: URLSearchParams
}

declare class URLSearchParams {
  constructor(init?: string)
  get(name: string): string | null
}

declare function decodeURIComponent(encodedURIComponent: string): string
declare function encodeURIComponent(uriComponent: string | number | boolean): string

interface ImportMeta {
  url: string
}

declare const console: {
  log(...args: unknown[]): void
  error(...args: unknown[]): void
}
