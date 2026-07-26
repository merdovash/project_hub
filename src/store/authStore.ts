import { create } from 'zustand'
import { fetchMe, login as apiLogin, logout as apiLogout, register as apiRegister, type AuthUser } from '../lib/authApi'

interface AuthState {
  user: AuthUser | null
  loading: boolean
  initialized: boolean
  error: string | null
  init: () => Promise<void>
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  clearError: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loading: false,
  initialized: false,
  error: null,

  init: async () => {
    set({ loading: true, error: null })
    try {
      const user = await fetchMe()
      set({ user, initialized: true, loading: false })
    } catch (err) {
      set({
        user: null,
        initialized: true,
        loading: false,
        error: err instanceof Error ? err.message : 'Не удалось проверить сессию',
      })
    }
  },

  login: async (email, password) => {
    set({ loading: true, error: null })
    try {
      const user = await apiLogin(email, password)
      set({ user, loading: false })
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'Не удалось войти',
      })
      throw err
    }
  },

  register: async (email, password) => {
    set({ loading: true, error: null })
    try {
      const user = await apiRegister(email, password)
      set({ user, loading: false })
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'Не удалось зарегистрироваться',
      })
      throw err
    }
  },

  logout: async () => {
    set({ loading: true, error: null })
    try {
      await apiLogout()
      set({ user: null, loading: false })
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : 'Не удалось выйти',
      })
      throw err
    }
  },

  clearError: () => set({ error: null }),
}))
