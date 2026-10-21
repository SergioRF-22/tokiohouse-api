import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { csrf } from 'hono/csrf'
import { HTTPException } from 'hono/http-exception'
import { logger } from 'hono/logger'
import { auth, requireSession, type AppEnv } from './auth.ts'
import { shopping } from './shopping.ts'
import { tasks } from './tasks.ts'

const origin = process.env.CORS_ORIGIN ?? 'http://localhost:5173'

const app = new Hono<AppEnv>()

app.use(logger())
app.use(cors({ origin, credentials: true }))
app.use(csrf({ origin }))
app.use(requireSession)

app.get('/health', (c) => c.json({ ok: true }))
app.route('/auth', auth)
app.route('/shopping', shopping)
app.route('/tasks', tasks)

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse()
  console.error(err)
  return c.json({ error: 'Error interno' }, 500)
})

export default app
