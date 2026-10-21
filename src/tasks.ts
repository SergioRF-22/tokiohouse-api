import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { db } from './db/index.ts'
import type { AppEnv } from './auth.ts'

type Tarea = { id: number; texto: string; posicion: number; creado_por: string }

const fail = (status: 400 | 404, message: string) =>
  new HTTPException(status, { res: Response.json({ error: message }, { status }) })

function parseId(raw: string): number {
  const id = Number(raw)
  if (!Number.isSafeInteger(id) || id <= 0) throw fail(400, 'Id no válido')
  return id
}

const SELECT = 'SELECT t.id, t.texto, t.posicion, u.username AS creado_por FROM tasks t JOIN users u ON u.id = t.created_by'

const lista = () => db.prepare(`${SELECT} ORDER BY t.posicion, t.id`).all() as Tarea[]

export const tasks = new Hono<AppEnv>()

tasks.get('/', (c) => c.json({ tareas: lista() }))

tasks.post('/', async (c) => {
  const body = await c.req.json().catch(() => null)
  const texto = typeof body?.texto === 'string' ? body.texto.trim() : ''
  if (!texto || texto.length > 200) throw fail(400, 'El texto debe tener entre 1 y 200 caracteres')

  const { id } = db
    .prepare(
      'INSERT INTO tasks (texto, posicion, created_by) VALUES (?, (SELECT COALESCE(MAX(posicion), -1) + 1 FROM tasks), ?) RETURNING id',
    )
    .get(texto, c.get('user').id) as { id: number }
  return c.json(db.prepare(`${SELECT} WHERE t.id = ?`).get(id) as Tarea, 201)
})

// Reordena. Los ids desconocidos se ignoran y los que falten
// (añadidos por la otra persona entre medias) se quedan al final.
tasks.put('/orden', async (c) => {
  const body = await c.req.json().catch(() => null)
  const ids: unknown = body?.ids
  if (!Array.isArray(ids) || !ids.every((i) => Number.isSafeInteger(i))) {
    throw fail(400, 'ids debe ser una lista de enteros')
  }
  if (new Set(ids).size !== ids.length) throw fail(400, 'ids repetidos')

  const actuales = (db.prepare('SELECT id FROM tasks ORDER BY posicion, id').all() as { id: number }[]).map((r) => r.id)
  const pedidos = new Set<number>(ids)
  const orden = [...ids.filter((i: number) => actuales.includes(i)), ...actuales.filter((i) => !pedidos.has(i))]

  const upd = db.prepare('UPDATE tasks SET posicion = ? WHERE id = ?')
  db.exec('BEGIN')
  try {
    orden.forEach((id, pos) => upd.run(pos, id))
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return c.body(null, 204)
})

tasks.delete('/:id', (c) => {
  const { changes } = db.prepare('DELETE FROM tasks WHERE id = ?').run(parseId(c.req.param('id')))
  if (!changes) throw fail(404, 'No existe')
  return c.body(null, 204)
})
