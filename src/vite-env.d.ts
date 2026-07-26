/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PORTAL_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
