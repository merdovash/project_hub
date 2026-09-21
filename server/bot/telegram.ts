/** Minimal Telegram Bot API client (long polling, no npm dependencies). */

export interface TgUser {
  id: number
  username?: string
  first_name?: string
}

export interface TgChat {
  id: number
  type: string
}

export interface TgMessage {
  message_id: number
  date: number
  text?: string
  chat: TgChat
  from?: TgUser
}

export interface TgCallbackQuery {
  id: string
  from: TgUser
  message?: TgMessage
  data?: string
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
  callback_query?: TgCallbackQuery
}

export interface InlineKeyboardButton {
  text: string
  callback_data: string
}

const MAX_MESSAGE_LENGTH = 4000

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Split long text into Telegram-sized chunks on line boundaries when possible. */
export function chunkText(text: string, limit: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut <= 0) cut = limit
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest) chunks.push(rest)
  return chunks
}

export class TelegramApi {
  private token: string

  constructor(token: string) {
    this.token = token
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const controller = new AbortController()
    // Long polling uses Telegram-side timeout; add network-level guard on top.
    const timeoutSec = typeof params.timeout === 'number' ? params.timeout : 0
    const timer = setTimeout(() => controller.abort(), (timeoutSec + 30) * 1000)
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      })
      const data = (await res.json()) as { ok: boolean; result?: T; description?: string }
      if (!data.ok) {
        throw new Error(`Telegram ${method} failed: ${data.description ?? res.status}`)
      }
      return data.result as T
    } finally {
      clearTimeout(timer)
    }
  }

  getUpdates(offset: number, timeoutSec: number): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>('getUpdates', {
      offset,
      timeout: timeoutSec,
      allowed_updates: ['message', 'callback_query'],
    })
  }

  /** Send HTML message; long text is split into multiple messages. */
  async sendMessage(
    chatId: number,
    html: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const chunks = chunkText(html)
    for (let i = 0; i < chunks.length; i += 1) {
      // Keyboard only on the last chunk
      const isLast = i === chunks.length - 1
      await this.call('sendMessage', {
        chat_id: chatId,
        text: chunks[i],
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(isLast ? extra : {}),
      })
    }
  }

  sendWithButtons(chatId: number, html: string, buttons: InlineKeyboardButton[]): Promise<void> {
    return this.sendMessage(chatId, html, {
      reply_markup: { inline_keyboard: [buttons] },
    })
  }

  async answerCallback(callbackId: string, text?: string): Promise<void> {
    try {
      await this.call('answerCallbackQuery', { callback_query_id: callbackId, text })
    } catch {
      /* callback may be too old — ignore */
    }
  }

  async editMessage(chatId: number, messageId: number, html: string): Promise<void> {
    try {
      await this.call('editMessageText', {
        chat_id: chatId,
        message_id: messageId,
        text: html,
        parse_mode: 'HTML',
      })
    } catch {
      /* message may be unchanged/deleted — ignore */
    }
  }

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    try {
      await this.call('deleteMessage', { chat_id: chatId, message_id: messageId })
    } catch {
      /* not critical (older than 48h, no rights, etc.) */
    }
  }

  async setMyCommands(commands: { command: string; description: string }[]): Promise<void> {
    try {
      await this.call('setMyCommands', { commands })
    } catch {
      /* cosmetic — ignore */
    }
  }
}
