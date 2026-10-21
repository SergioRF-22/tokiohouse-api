import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { db } from './db/index.ts'
import type { AppEnv } from './auth.ts'

export const CATEGORIAS = [
  'Proteína',
  'Verduras',
  'Frutas',
  'Hidratos',
  'Despensa',
  'Limpieza',
  'Higiene',
  'Otro',
] as const

type Item = { id: number; nombre: string; categoria: string; en_bolsa: boolean; posicion: number | null; comprado: boolean }
type Row = { id: number; nombre: string; categoria: string; en_bolsa: number; posicion: number | null; comprado: number }

const toItem = (r: Row): Item => ({
  id: r.id,
  nombre: r.nombre,
  categoria: r.categoria,
  en_bolsa: r.en_bolsa === 1,
  posicion: r.posicion,
  comprado: r.comprado === 1,
})

const fail = (status: 400 | 404, message: string) =>
  new HTTPException(status, { res: Response.json({ error: message }, { status }) })

function parseId(raw: string): number {
  const id = Number(raw)
  if (!Number.isSafeInteger(id) || id <= 0) throw fail(400, 'Id no válido')
  return id
}

const nextPosition = () =>
  (db.prepare('SELECT COALESCE(MAX(posicion), -1) + 1 AS n FROM shopping_items').get() as { n: number }).n

const find = (id: number) => db.prepare('SELECT * FROM shopping_items WHERE id = ?').get(id) as Row | undefined

export const shopping = new Hono<AppEnv>()

shopping.get('/', (c) => {
  const bolsa = db
    .prepare('SELECT * FROM shopping_items WHERE en_bolsa = 1 ORDER BY nombre COLLATE NOCASE, id')
    .all() as Row[]
  const lista = db
    .prepare('SELECT * FROM shopping_items WHERE posicion IS NOT NULL ORDER BY posicion, id')
    .all() as Row[]
  return c.json({ categorias: CATEGORIAS, bolsa: bolsa.map(toItem), lista: lista.map(toItem) })
})

shopping.post('/', async (c) => {
  const body = await c.req.json().catch(() => null)
  const nombre = typeof body?.nombre === 'string' ? body.nombre.trim() : ''
  if (!nombre || nombre.length > 60) throw fail(400, 'El nombre debe tener entre 1 y 60 caracteres')
  if (!CATEGORIAS.includes(body?.categoria)) throw fail(400, 'Categoría no válida')
  if (typeof body?.en_lista !== 'boolean' || typeof body?.en_bolsa !== 'boolean') {
    throw fail(400, 'en_lista y en_bolsa deben ser booleanos')
  }
  if (!body.en_lista && !body.en_bolsa) throw fail(400, 'El producto debe ir a la lista o a la bolsa')

  const row = db
    .prepare('INSERT INTO shopping_items (nombre, categoria, en_bolsa, posicion) VALUES (?, ?, ?, ?) RETURNING *')
    .get(nombre, body.categoria, body.en_bolsa ? 1 : 0, body.en_lista ? nextPosition() : null) as Row
  return c.json(toItem(row), 201)
})

// Reordena la lista. Los ids desconocidos se ignoran y los que falten
// (añadidos por la otra persona entre medias) se quedan al final.
shopping.put('/lista/orden', async (c) => {
  const body = await c.req.json().catch(() => null)
  const ids: unknown = body?.ids
  if (!Array.isArray(ids) || !ids.every((i) => Number.isSafeInteger(i))) {
    throw fail(400, 'ids debe ser una lista de enteros')
  }
  if (new Set(ids).size !== ids.length) throw fail(400, 'ids repetidos')

  const actuales = (
    db.prepare('SELECT id FROM shopping_items WHERE posicion IS NOT NULL ORDER BY posicion, id').all() as { id: number }[]
  ).map((r) => r.id)
  const pedidos = new Set<number>(ids)
  const orden = [...ids.filter((i: number) => actuales.includes(i)), ...actuales.filter((i) => !pedidos.has(i))]

  const upd = db.prepare('UPDATE shopping_items SET posicion = ? WHERE id = ?')
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

// Añade un producto de la bolsa al final de la lista (idempotente).
shopping.post('/:id/lista', (c) => {
  const row = find(parseId(c.req.param('id')))
  if (!row) throw fail(404, 'No existe')
  if (row.posicion !== null) return c.json(toItem(row))
  const updated = db
    .prepare('UPDATE shopping_items SET posicion = ? WHERE id = ? RETURNING *')
    .get(nextPosition(), row.id) as Row
  return c.json(toItem(updated))
})

// Quita de la lista. Si no estaba en la bolsa, el producto desaparece.
shopping.delete('/:id/lista', (c) => {
  const row = find(parseId(c.req.param('id')))
  if (!row) throw fail(404, 'No existe')
  if (row.en_bolsa) db.prepare('UPDATE shopping_items SET posicion = NULL, comprado = 0 WHERE id = ?').run(row.id)
  else db.prepare('DELETE FROM shopping_items WHERE id = ?').run(row.id)
  return c.body(null, 204)
})

// Marca o desmarca como comprado (tachado) un producto de la lista.
shopping.put('/:id/comprado', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (typeof body?.comprado !== 'boolean') throw fail(400, 'comprado debe ser booleano')
  const row = db
    .prepare('UPDATE shopping_items SET comprado = ? WHERE id = ? AND posicion IS NOT NULL RETURNING *')
    .get(body.comprado ? 1 : 0, parseId(c.req.param('id'))) as Row | undefined
  if (!row) throw fail(404, 'No está en la lista')
  return c.json(toItem(row))
})

// Pasa un producto a la bolsa: sale de la lista y se marca en_bolsa (idempotente).
shopping.post('/:id/bolsa', (c) => {
  const row = db
    .prepare('UPDATE shopping_items SET en_bolsa = 1, posicion = NULL, comprado = 0 WHERE id = ? RETURNING *')
    .get(parseId(c.req.param('id'))) as Row | undefined
  if (!row) throw fail(404, 'No existe')
  return c.json(toItem(row))
})

// Cierra la compra: los tachados salen de la lista, a la bolsa o borrados del todo.
shopping.post('/lista/terminar', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (body?.accion !== 'bolsa' && body?.accion !== 'eliminar') throw fail(400, "accion debe ser 'bolsa' o 'eliminar'")
  const sql =
    body.accion === 'bolsa'
      ? 'UPDATE shopping_items SET en_bolsa = 1, posicion = NULL, comprado = 0 WHERE comprado = 1 AND posicion IS NOT NULL'
      : 'DELETE FROM shopping_items WHERE comprado = 1 AND posicion IS NOT NULL'
  const { changes } = db.prepare(sql).run()
  return c.json({ afectados: Number(changes) })
})

// Borra del todo: sale de la bolsa y de la lista.
shopping.delete('/:id', (c) => {
  const { changes } = db.prepare('DELETE FROM shopping_items WHERE id = ?').run(parseId(c.req.param('id')))
  if (!changes) throw fail(404, 'No existe')
  return c.body(null, 204)
})
