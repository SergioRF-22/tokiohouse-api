import { serve } from '@hono/node-server'
import app from './app.ts'
import { db } from './db/index.ts'

const port = Number(process.env.PORT ?? 3000)
const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () =>
  console.log(`escuchando en 0.0.0.0:${port}`),
)

function shutdown() {
  console.log('cerrando...')
  server.close(() => {
    db.close()
    process.exit(0)
  })
  if ('closeAllConnections' in server) server.closeAllConnections()
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
