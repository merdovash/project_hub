/**
 * Telegram ops bot for the hub.
 *
 * Commands: /auth (password, 24h session), /status, /db, /restart (pm2 restart of the hub),
 * /redeploy (full deploy-all.sh: git pull + rebuild + restart), /logs, /logout.
 *
 * Run:            npm run bot            (PM2: portal-bot, started by deploy scripts)
 * Password hash:  npm run bot:password -- 'пароль'   → put into .env BOT_PASSWORD_HASH
 *
 * Security: optional TELEGRAM_ALLOWED_USER_IDS allowlist, scrypt password hash,
 * attempt rate limiting with lockout, confirmation buttons, audit log, private chats only.
 */
import { randomBytes } from 'node:crypto'
import { hashPassword, verifyPassword } from '../auth/password'
import { loadEnvFile } from '../db/pool'
import {
  audit,
  blockedForMs,
  clearPendingDeploy,
  grantSession,
  isAuthed,
  loadPendingDeploy,
  registerFailedAttempt,
  revokeSession,
  savePendingDeploy,
  sessionExpiry,
  SESSION_TTL_MS_DEFAULT,
} from './state'
import {
  deployExitCode,
  formatDuration,
  getDbStatus,
  getSystemStatus,
  pm2Logs,
  restartHub,
  startDetachedDeploy,
  tailFile,
} from './system'
import { escapeHtml, TelegramApi, type TgCallbackQuery, type TgMessage } from './telegram'

const DEPLOY_TIMEOUT_MS = 30 * 60 * 1000
const CONFIRM_TTL_MS = 60 * 1000

type ConfirmAction = 'restart' | 'redeploy'

interface PendingConfirm {
  userId: number
  action: ConfirmAction
  expiresAt: number
}

const pendingConfirms = new Map<string, PendingConfirm>()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(() => resolve(), ms))
}

function sessionTtlMs(): number {
  const hours = Number(process.env.BOT_SESSION_TTL_HOURS ?? '')
  if (Number.isFinite(hours) && hours > 0) return hours * 60 * 60 * 1000
  return SESSION_TTL_MS_DEFAULT
}

function allowedUserIds(): Set<number> | null {
  const raw = process.env.TELEGRAM_ALLOWED_USER_IDS?.trim()
  if (!raw) return null
  const ids = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isFinite(id) && id > 0)
  return ids.length > 0 ? new Set(ids) : null
}

const HELP_TEXT = [
  '<b>Команды</b>',
  '/auth &lt;пароль&gt; — вход (сессия на 24 часа)',
  '/status — загрузка сервера и PM2-процессы',
  '/db — размер базы данных и топ таблиц',
  '/restart — быстрый перезапуск хаба (pm2 restart, без пересборки)',
  '/redeploy — полное переразвёртывание: git pull → build → перезапуск хаба и сервисов',
  '/logs [имя] [строк] — последние логи PM2 (по умолчанию portal, 30 строк)',
  '/logout — завершить сессию',
].join('\n')

interface BotContext {
  api: TelegramApi
  allowlist: Set<number> | null
}

async function watchDeploy(
  ctx: BotContext,
  chatId: number,
  logFile: string,
  startedAt: number,
  label: string,
): Promise<void> {
  for (;;) {
    const code = deployExitCode(logFile)
    if (code !== null) {
      clearPendingDeploy()
      const took = formatDuration(Date.now() - startedAt)
      const tail = escapeHtml(tailFile(logFile, 25))
      const head =
        code === 0
          ? `✅ <b>${escapeHtml(label)}: успешно</b> (${took})`
          : `❌ <b>${escapeHtml(label)}: ошибка (код ${code})</b> (${took})`
      await ctx.api.sendMessage(chatId, `${head}\n\n<pre>${tail || '(лог пуст)'}</pre>`)
      return
    }
    if (Date.now() - startedAt > DEPLOY_TIMEOUT_MS) {
      clearPendingDeploy()
      await ctx.api.sendMessage(
        chatId,
        `⚠️ <b>${escapeHtml(label)}: нет ответа за 30 минут.</b>\nПроверьте вручную: <code>pm2 ls</code>, лог ${escapeHtml(logFile)}`,
      )
      return
    }
    await sleep(5000)
  }
}

async function runRestart(ctx: BotContext, chatId: number): Promise<void> {
  await ctx.api.sendMessage(chatId, '🔄 Перезапускаю хаб (pm2 restart)…')
  const result = restartHub()
  if (result.ok) {
    await ctx.api.sendMessage(chatId, '✅ Хаб перезапущен. Проверить: /status')
  } else {
    await ctx.api.sendMessage(
      chatId,
      `❌ Ошибка перезапуска:\n<pre>${escapeHtml(result.out.slice(-1500) || 'нет вывода')}</pre>`,
    )
  }
}

async function runRedeploy(ctx: BotContext, chatId: number): Promise<void> {
  if (loadPendingDeploy()) {
    await ctx.api.sendMessage(chatId, '⏳ Деплой уже выполняется — дождитесь завершения.')
    return
  }
  const { logFile } = startDetachedDeploy()
  const startedAt = Date.now()
  savePendingDeploy({ chatId, logFile, startedAt, label: 'Redeploy' })
  await ctx.api.sendMessage(
    chatId,
    '🚀 Запущено полное переразвёртывание (git pull → build → рестарт хаба и сервисов).\n' +
      'Обычно занимает несколько минут, пришлю результат. Бот может кратко перезапуститься в процессе.',
  )
  void watchDeploy(ctx, chatId, logFile, startedAt, 'Redeploy')
}

function askConfirm(
  ctx: BotContext,
  chatId: number,
  userId: number,
  action: ConfirmAction,
): Promise<void> {
  const nonce = randomBytes(8).toString('hex')
  pendingConfirms.set(nonce, { userId, action, expiresAt: Date.now() + CONFIRM_TTL_MS })
  const label =
    action === 'restart'
      ? 'перезапустить хаб (без пересборки)'
      : 'полностью переразвернуть хаб и все сервисы'
  return ctx.api.sendWithButtons(chatId, `Подтвердите: <b>${label}</b>?`, [
    { text: '✅ Да', callback_data: `ok:${nonce}` },
    { text: '❌ Отмена', callback_data: `no:${nonce}` },
  ])
}

async function handleCallback(ctx: BotContext, cb: TgCallbackQuery): Promise<void> {
  const chatId = cb.message?.chat.id
  const data = cb.data ?? ''
  const [verb, nonce] = data.split(':')
  const pending = nonce ? pendingConfirms.get(nonce) : undefined

  if (!pending || !chatId) {
    await ctx.api.answerCallback(cb.id, 'Запрос устарел')
    return
  }
  if (pending.userId !== cb.from.id) {
    await ctx.api.answerCallback(cb.id, 'Кнопка не для вас')
    return
  }
  pendingConfirms.delete(nonce!)
  if (cb.message) {
    await ctx.api.editMessage(chatId, cb.message.message_id, cb.message.text ?? '…')
  }
  if (verb !== 'ok' || pending.expiresAt < Date.now()) {
    await ctx.api.answerCallback(cb.id, verb === 'ok' ? 'Запрос устарел' : 'Отменено')
    if (verb === 'ok') await ctx.api.sendMessage(chatId, 'Подтверждение устарело, повторите команду.')
    return
  }
  if (!isAuthed(cb.from.id)) {
    await ctx.api.answerCallback(cb.id, 'Сессия истекла')
    await ctx.api.sendMessage(chatId, 'Сессия истекла — выполните /auth заново.')
    return
  }
  await ctx.api.answerCallback(cb.id, 'Выполняю')
  audit(cb.from.id, cb.from.username, `confirmed ${pending.action}`)
  if (pending.action === 'restart') {
    await runRestart(ctx, chatId)
  } else {
    await runRedeploy(ctx, chatId)
  }
}

async function handleAuth(ctx: BotContext, msg: TgMessage, password: string): Promise<void> {
  const chatId = msg.chat.id
  const userId = msg.from!.id
  // Never keep the password on screen
  await ctx.api.deleteMessage(chatId, msg.message_id)

  const blockedMs = blockedForMs(userId)
  if (blockedMs > 0) {
    await ctx.api.sendMessage(
      chatId,
      `🚫 Слишком много неверных попыток. Попробуйте через ${formatDuration(blockedMs)}.`,
    )
    return
  }

  const storedHash = process.env.BOT_PASSWORD_HASH?.trim()
  if (!storedHash) {
    await ctx.api.sendMessage(
      chatId,
      'BOT_PASSWORD_HASH не задан в .env — вход невозможен. См. deploy/BOT.md.',
    )
    return
  }
  if (!password) {
    await ctx.api.sendMessage(chatId, 'Использование: /auth пароль')
    return
  }

  if (verifyPassword(password, storedHash)) {
    const expiresAt = grantSession(userId, sessionTtlMs())
    audit(userId, msg.from?.username, 'auth success')
    await ctx.api.sendMessage(
      chatId,
      `✅ Доступ открыт до ${new Date(expiresAt).toISOString().slice(0, 16).replace('T', ' ')} UTC.\n\n${HELP_TEXT}`,
    )
  } else {
    const fail = registerFailedAttempt(userId)
    audit(userId, msg.from?.username, 'auth FAILED')
    const suffix = fail.blockedForMs
      ? ` Вход заблокирован на ${formatDuration(fail.blockedForMs)}.`
      : ` Осталось попыток: ${fail.remaining}.`
    await ctx.api.sendMessage(chatId, `❌ Неверный пароль.${suffix}`)
  }
}

async function handleMessage(ctx: BotContext, msg: TgMessage): Promise<void> {
  const text = msg.text?.trim() ?? ''
  const userId = msg.from?.id
  const chatId = msg.chat.id
  if (!userId || !text.startsWith('/')) return
  // Ops bot works only in private chats: no group can see commands or output
  if (msg.chat.type !== 'private') return
  if (ctx.allowlist && !ctx.allowlist.has(userId)) {
    audit(userId, msg.from?.username, `REJECTED (not in allowlist): ${text.split(' ')[0]}`)
    return
  }

  const [rawCommand, ...args] = text.split(/\s+/)
  const command = rawCommand!.split('@')[0]!.toLowerCase()

  if (command === '/start' || command === '/help') {
    const authed = isAuthed(userId)
    const authLine = authed
      ? `Сессия активна до ${new Date(sessionExpiry(userId)!).toISOString().slice(0, 16).replace('T', ' ')} UTC.`
      : 'Сначала войдите: /auth пароль'
    await ctx.api.sendMessage(chatId, `${HELP_TEXT}\n\n${authLine}`)
    return
  }

  if (command === '/auth') {
    await handleAuth(ctx, msg, args.join(' '))
    return
  }

  if (!isAuthed(userId)) {
    await ctx.api.sendMessage(chatId, '🔒 Нужна авторизация: /auth пароль (действует 24 часа).')
    return
  }

  switch (command) {
    case '/logout':
      revokeSession(userId)
      audit(userId, msg.from?.username, 'logout')
      await ctx.api.sendMessage(chatId, 'Сессия завершена.')
      return
    case '/status':
      audit(userId, msg.from?.username, 'status')
      await ctx.api.sendMessage(chatId, getSystemStatus())
      return
    case '/db':
      audit(userId, msg.from?.username, 'db')
      try {
        await ctx.api.sendMessage(chatId, await getDbStatus())
      } catch (err) {
        await ctx.api.sendMessage(
          chatId,
          `❌ Не удалось получить данные БД:\n<pre>${escapeHtml(err instanceof Error ? err.message : String(err))}</pre>`,
        )
      }
      return
    case '/restart':
      await askConfirm(ctx, chatId, userId, 'restart')
      return
    case '/redeploy':
      await askConfirm(ctx, chatId, userId, 'redeploy')
      return
    case '/logs': {
      const name = args[0] ?? process.env.PM2_APP_NAME?.trim() ?? 'portal'
      const lines = Number(args[1] ?? '30') || 30
      audit(userId, msg.from?.username, `logs ${name}`)
      const output = pm2Logs(name, lines)
      await ctx.api.sendMessage(chatId, `<pre>${escapeHtml(output.slice(-3500))}</pre>`)
      return
    }
    default:
      await ctx.api.sendMessage(chatId, `Неизвестная команда. ${HELP_TEXT}`)
  }
}

async function runBot(): Promise<void> {
  loadEnvFile()
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN is not set in .env — see deploy/BOT.md')
    process.exit(1)
  }
  if (!process.env.BOT_PASSWORD_HASH?.trim()) {
    console.error("WARNING: BOT_PASSWORD_HASH not set — nobody will be able to /auth. Generate: npm run bot:password -- 'пароль'")
  }

  const ctx: BotContext = { api: new TelegramApi(token), allowlist: allowedUserIds() }
  await ctx.api.setMyCommands([
    { command: 'status', description: 'Загрузка сервера и PM2' },
    { command: 'db', description: 'Размер базы данных' },
    { command: 'restart', description: 'Перезапустить хаб (без пересборки)' },
    { command: 'redeploy', description: 'Полный redeploy хаба и сервисов' },
    { command: 'logs', description: 'Логи PM2' },
    { command: 'auth', description: 'Вход по паролю (24 часа)' },
    { command: 'logout', description: 'Завершить сессию' },
    { command: 'help', description: 'Справка' },
  ])

  // If a deploy was running when the bot restarted (redeploy restarts the bot too) — resume reporting
  const pending = loadPendingDeploy()
  if (pending) {
    void watchDeploy(ctx, pending.chatId, pending.logFile, pending.startedAt, pending.label)
  }

  console.log(
    `Bot started. Allowlist: ${ctx.allowlist ? [...ctx.allowlist].join(', ') : 'off (any user may try /auth)'}`,
  )

  let offset = 0
  for (;;) {
    try {
      const updates = await ctx.api.getUpdates(offset, 50)
      for (const update of updates) {
        offset = update.update_id + 1
        try {
          if (update.message) await handleMessage(ctx, update.message)
          if (update.callback_query) await handleCallback(ctx, update.callback_query)
        } catch (err) {
          console.error('update handling failed', err)
        }
      }
    } catch (err) {
      console.error('polling failed, retrying in 5s', err)
      await sleep(5000)
    }
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2]
  if (cmd === 'hash-password') {
    const password = process.argv[3]
    if (!password) {
      console.error("Usage: npm run bot:password -- 'пароль'")
      process.exit(1)
    }
    console.log(`BOT_PASSWORD_HASH=${hashPassword(password)}`)
    return
  }
  await runBot()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
