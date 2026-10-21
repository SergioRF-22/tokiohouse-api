import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { createHash, randomBytes } from 'node:crypto'
import { db } from './db/index.ts'
import { hashPassword, verifyPassword } from './password.ts'

export type AppEnv = { Variables: { user: { id: number; username: string } } }

const COOKIE = 'sid'
const SESSION_SECONDS = 60 * 60 * 24 * 30
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex')

// Hash de relleno para que el login tarde igual si el usuario no existe.
const dummyHash = await hashPassword('dummy')

// Rate limit en memoria por IP: MAX_ATTEMPTS intentos de login por ventana.
const WINDOW_MS = 15 * 60 * 1000
const MAX_ATTEMPTS = 10
const attempts = new Map<string, { count: number; reset: number }>()

function limited(ip: string): boolean {
  const now = Date.now()
  const entry = attempts.get(ip)
  if (!entry || entry.reset < now) {
    attempts.set(ip, { count: 1, reset: now + WINDOW_MS })
    return false
  }
  return ++entry.count > MAX_ATTEMPTS
}

// Tras el proxy de Coolify, la IP real es la última de X-Forwarded-For.
const clientIp = (xff: string | undefined) => xff?.split(',').at(-1)?.trim() || 'unknown'

// Middleware global: todo requiere sesión salvo /health y /auth/login.
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.path === '/health' || c.req.path === '/auth/login') return next()
  const token = getCookie(c, COOKIE)
  const user = token
    ? (db
        .prepare(
          `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ? AND s.expires_at > ?`,
        )
        .get(hashToken(token), Date.now()) as AppEnv['Variables']['user'] | undefined)
    : undefined
  if (!user) return c.json({ error: 'No autenticado' }, 401)
  c.set('user', user)
  return next()
})

export const auth = new Hono<AppEnv>()

auth.post('/login', async (c) => {
  if (limited(clientIp(c.req.header('x-forwarded-for')))) {
    return c.json({ error: 'Demasiados intentos, prueba más tarde' }, 429)
  }
  const body = await c.req.json().catch(() => null)
  const username = typeof body?.username === 'string' ? body.username : ''
  const password = typeof body?.password === 'string' ? body.password : ''
  const row = db
    .prepare('SELECT id, username, password_hash FROM users WHERE username = ?')
    .get(username) as { id: number; username: string; password_hash: string } | undefined
  const ok = await verifyPassword(password, row?.password_hash ?? dummyHash)
  if (!row || !ok) return c.json({ error: 'Credenciales incorrectas' }, 401)

  const token = randomBytes(32).toString('base64url')
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now())
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    hashToken(token),
    row.id,
    Date.now() + SESSION_SECONDS * 1000,
  )
  setCookie(c, COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_SECONDS,
  })
  return c.json({ id: row.id, username: row.username })
})

auth.post('/logout', (c) => {
  const token = getCookie(c, COOKIE)
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token))
  deleteCookie(c, COOKIE, { path: '/' })
  return c.body(null, 204)
})

auth.get('/me', (c) => c.json(c.get('user')))
