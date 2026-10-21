import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { db } from './db/index.ts'
import type { AppEnv } from './auth.ts'

type Tipo = 'ingreso' | 'gasto'
type Categoria = { id: number; tipo: Tipo; nombre: string }
type Movimiento = {
  id: number
  tipo: Tipo
  importe_centimos: number
  categoria_id: number
  categoria: string
  fecha: string
  nota: string | null
  gasto_fijo_id: number | null
  trabajo: 0 | 1
}
type GastoFijo = {
  id: number
  nombre: string
  importe_centimos: number
  categoria_id: number
  categoria: string
  dia: number
  mes_inicio: string
  trabajo: 0 | 1
}

export const fail = (status: 400 | 404 | 409, message: string) =>
  new HTTPException(status, { res: Response.json({ error: message }, { status }) })

export function parseId(raw: string): number {
  const id = Number(raw)
  if (!Number.isSafeInteger(id) || id <= 0) throw fail(400, 'Id no válido')
  return id
}

const isTipo = (v: unknown): v is Tipo => v === 'ingreso' || v === 'gasto'

// "Hoy" en la zona del usuario, no la del servidor (el contenedor va en UTC).
const hoyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' })
export const hoy = () => hoyFmt.format(new Date())

export const isFecha = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v
export const isMes = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v)

export function siguienteMes(mes: string): string {
  const y = Number(mes.slice(0, 4))
  const m = Number(mes.slice(5, 7))
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}

// Rango pedido por query: por defecto, el mes actual.
function rango(desdeQ: string | undefined, hastaQ: string | undefined): [string, string] {
  const mes = hoy().slice(0, 7)
  const desde = desdeQ ?? `${mes}-01`
  const hasta = hastaQ ?? ultimoDia(mes)
  if (!isFecha(desde) || !isFecha(hasta)) throw fail(400, 'desde y hasta deben ser fechas YYYY-MM-DD')
  if (desde > hasta) throw fail(400, 'desde no puede ser posterior a hasta')
  return [desde, hasta]
}

// ?trabajo=1 deja solo lo de trabajo (trabajo >= 1); sin él, trabajo >= 0 es todo.
const soloTrabajo = (q: string | undefined) => (q === '1' ? 1 : 0)

export const ultimoDia = (mes: string) => new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0)).toISOString().slice(0, 10)

// Crea los movimientos que falten de cada gasto fijo: desde su mes de inicio hasta el mes
// actual, sin pasar de hoy ni de su baja. generado_hasta evita recrear los que se borraron;
// el índice único (gasto_fijo_id, mes) es la red de seguridad contra duplicados.
function materializar(userId: number) {
  const fechaHoy = hoy()
  const mesActual = fechaHoy.slice(0, 7)
  const fijos = db
    .prepare(
      `SELECT id, nombre, importe_centimos, categoria_id, dia, mes_inicio, baja, generado_hasta, trabajo
       FROM fin_gastos_fijos
       WHERE user_id = ? AND (generado_hasta IS NULL OR generado_hasta < ?)`,
    )
    .all(userId, mesActual) as {
    id: number
    nombre: string
    importe_centimos: number
    categoria_id: number
    dia: number
    mes_inicio: string
    trabajo: number
    baja: string | null
    generado_hasta: string | null
  }[]
  if (fijos.length === 0) return

  const ins = db.prepare(
    `INSERT OR IGNORE INTO fin_movimientos (user_id, tipo, importe_centimos, categoria_id, fecha, nota, gasto_fijo_id, trabajo)
     VALUES (?, 'gasto', ?, ?, ?, ?, ?, ?)`,
  )
  const upd = db.prepare('UPDATE fin_gastos_fijos SET generado_hasta = ? WHERE id = ?')
  db.exec('BEGIN')
  try {
    for (const f of fijos) {
      let mes = f.generado_hasta ? siguienteMes(f.generado_hasta) : f.mes_inicio
      let hasta = f.generado_hasta
      for (; mes <= mesActual; mes = siguienteMes(mes)) {
        const fecha = `${mes}-${String(f.dia).padStart(2, '0')}`
        if (fecha > fechaHoy || (f.baja !== null && fecha >= f.baja)) break
        ins.run(userId, f.importe_centimos, f.categoria_id, fecha, f.nombre, f.id, f.trabajo)
        hasta = mes
      }
      if (hasta !== f.generado_hasta) upd.run(hasta, f.id)
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

const categoriaDe = (userId: number, id: unknown) =>
  typeof id === 'number' && Number.isSafeInteger(id)
    ? (db.prepare('SELECT id, tipo, nombre FROM fin_categorias WHERE id = ? AND user_id = ?').get(id, userId) as Categoria | undefined)
    : undefined

export const finanzas = new Hono<AppEnv>()

// --- Categorías ---

finanzas.get('/categorias', (c) => {
  const tipo = c.req.query('tipo')
  if (tipo !== undefined && !isTipo(tipo)) throw fail(400, 'tipo debe ser ingreso o gasto')
  const categorias = db
    .prepare(
      `SELECT id, tipo, nombre FROM fin_categorias
       WHERE user_id = ? AND (? IS NULL OR tipo = ?) ORDER BY tipo, nombre COLLATE NOCASE, id`,
    )
    .all(c.get('user').id, tipo ?? null, tipo ?? null) as Categoria[]
  return c.json({ categorias })
})

finanzas.post('/categorias', async (c) => {
  const body = await c.req.json().catch(() => null)
  const nombre = typeof body?.nombre === 'string' ? body.nombre.trim() : ''
  if (!isTipo(body?.tipo)) throw fail(400, 'tipo debe ser ingreso o gasto')
  if (!nombre || nombre.length > 40) throw fail(400, 'El nombre debe tener entre 1 y 40 caracteres')

  try {
    const cat = db
      .prepare('INSERT INTO fin_categorias (user_id, tipo, nombre) VALUES (?, ?, ?) RETURNING id, tipo, nombre')
      .get(c.get('user').id, body.tipo, nombre) as Categoria
    return c.json(cat, 201)
  } catch (e) {
    if (e instanceof Error && /UNIQUE/.test(e.message)) throw fail(409, 'Esa categoría ya existe')
    throw e
  }
})

// --- Movimientos ---

const MOV_SELECT = `SELECT m.id, m.tipo, m.importe_centimos, m.categoria_id, k.nombre AS categoria, m.fecha, m.nota, m.gasto_fijo_id, m.trabajo
  FROM fin_movimientos m JOIN fin_categorias k ON k.id = m.categoria_id`

finanzas.get('/movimientos', (c) => {
  const user = c.get('user')
  const [desde, hasta] = rango(c.req.query('desde'), c.req.query('hasta'))
  materializar(user.id)
  const movimientos = db
    .prepare(`${MOV_SELECT} WHERE m.user_id = ? AND m.fecha BETWEEN ? AND ? AND m.trabajo >= ? ORDER BY m.fecha DESC, m.id DESC`)
    .all(user.id, desde, hasta, soloTrabajo(c.req.query('trabajo'))) as Movimiento[]
  return c.json({ movimientos })
})

finanzas.post('/movimientos', async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => null)
  if (!isTipo(body?.tipo)) throw fail(400, 'tipo debe ser ingreso o gasto')
  const importe = body.importe_centimos
  if (!Number.isSafeInteger(importe) || importe <= 0) throw fail(400, 'El importe debe ser un entero de céntimos mayor que 0')
  const cat = categoriaDe(user.id, body.categoria_id)
  if (!cat || cat.tipo !== body.tipo) throw fail(400, 'Categoría no válida para ese tipo')
  const fecha = body.fecha ?? hoy()
  if (!isFecha(fecha)) throw fail(400, 'fecha debe ser YYYY-MM-DD')
  const nota = typeof body.nota === 'string' ? body.nota.trim() : ''
  if (nota.length > 200) throw fail(400, 'La nota admite hasta 200 caracteres')
  if (body.trabajo !== undefined && typeof body.trabajo !== 'boolean') throw fail(400, 'trabajo debe ser booleano')
  const fijoId = body.gasto_fijo_id ?? null
  if (fijoId !== null) {
    const ok = Number.isSafeInteger(fijoId) && db.prepare('SELECT 1 FROM fin_gastos_fijos WHERE id = ? AND user_id = ?').get(fijoId, user.id)
    if (!ok) throw fail(400, 'Gasto fijo no válido')
    if (body.tipo !== 'gasto') throw fail(400, 'Solo un gasto puede venir de un gasto fijo')
  }

  try {
    const { id } = db
      .prepare(
        `INSERT INTO fin_movimientos (user_id, tipo, importe_centimos, categoria_id, fecha, nota, gasto_fijo_id, trabajo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(user.id, body.tipo, importe, cat.id, fecha, nota || null, fijoId, body.trabajo ? 1 : 0) as { id: number }
    return c.json(db.prepare(`${MOV_SELECT} WHERE m.id = ?`).get(id) as Movimiento, 201)
  } catch (e) {
    if (e instanceof Error && /UNIQUE/.test(e.message)) throw fail(409, 'Ese gasto fijo ya tiene movimiento en ese mes')
    throw e
  }
})

finanzas.delete('/movimientos/:id', (c) => {
  const { changes } = db
    .prepare('DELETE FROM fin_movimientos WHERE id = ? AND user_id = ?')
    .run(parseId(c.req.param('id')), c.get('user').id)
  if (!changes) throw fail(404, 'No existe')
  return c.body(null, 204)
})

// --- Gastos fijos ---

const FIJO_SELECT = `SELECT g.id, g.nombre, g.importe_centimos, g.categoria_id, k.nombre AS categoria, g.dia, g.mes_inicio, g.trabajo
  FROM fin_gastos_fijos g JOIN fin_categorias k ON k.id = g.categoria_id`

finanzas.get('/gastos-fijos', (c) => {
  const gastos_fijos = db
    .prepare(`${FIJO_SELECT} WHERE g.user_id = ? AND g.baja IS NULL ORDER BY g.dia, g.id`)
    .all(c.get('user').id) as GastoFijo[]
  return c.json({ gastos_fijos })
})

finanzas.post('/gastos-fijos', async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => null)
  const nombre = typeof body?.nombre === 'string' ? body.nombre.trim() : ''
  if (!nombre || nombre.length > 60) throw fail(400, 'El nombre debe tener entre 1 y 60 caracteres')
  const importe = body.importe_centimos
  if (!Number.isSafeInteger(importe) || importe <= 0) throw fail(400, 'El importe debe ser un entero de céntimos mayor que 0')
  const cat = categoriaDe(user.id, body.categoria_id)
  if (!cat || cat.tipo !== 'gasto') throw fail(400, 'La categoría debe ser de gasto')
  const dia = body.dia
  if (!Number.isInteger(dia) || dia < 1 || dia > 28) throw fail(400, 'El día debe estar entre 1 y 28')
  const mesInicio = body.mes_inicio ?? hoy().slice(0, 7)
  if (!isMes(mesInicio)) throw fail(400, 'mes_inicio debe ser YYYY-MM')
  if (body.trabajo !== undefined && typeof body.trabajo !== 'boolean') throw fail(400, 'trabajo debe ser booleano')

  const { id } = db
    .prepare(
      `INSERT INTO fin_gastos_fijos (user_id, nombre, importe_centimos, categoria_id, dia, mes_inicio, trabajo)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(user.id, nombre, importe, cat.id, dia, mesInicio, body.trabajo ? 1 : 0) as { id: number }
  return c.json(db.prepare(`${FIJO_SELECT} WHERE g.id = ?`).get(id) as GastoFijo, 201)
})

// "Quitar" = fecha de baja; los movimientos ya generados se quedan.
finanzas.post('/gastos-fijos/:id/baja', (c) => {
  const user = c.get('user')
  const id = parseId(c.req.param('id'))
  materializar(user.id) // lo ya vencido se genera antes de cerrar
  const { changes } = db
    .prepare('UPDATE fin_gastos_fijos SET baja = ? WHERE id = ? AND user_id = ? AND baja IS NULL')
    .run(hoy(), id, user.id)
  if (!changes) throw fail(404, 'No existe')
  return c.body(null, 204)
})

// --- Resumen (todo agregado en SQL) ---

finanzas.get('/resumen', (c) => {
  const user = c.get('user')
  const [desde, hasta] = rango(c.req.query('desde'), c.req.query('hasta'))
  materializar(user.id)
  const args = [user.id, desde, hasta, soloTrabajo(c.req.query('trabajo'))]

  const por_mes = db
    .prepare(
      `SELECT mes,
              COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN importe_centimos END), 0) AS ingresos,
              COALESCE(SUM(CASE WHEN tipo = 'gasto' THEN importe_centimos END), 0) AS gastos
       FROM fin_movimientos WHERE user_id = ? AND fecha BETWEEN ? AND ? AND trabajo >= ?
       GROUP BY mes ORDER BY mes`,
    )
    .all(...args)
  const por_categoria = db
    .prepare(
      `SELECT m.tipo, m.categoria_id, k.nombre AS categoria, SUM(m.importe_centimos) AS total
       FROM fin_movimientos m JOIN fin_categorias k ON k.id = m.categoria_id
       WHERE m.user_id = ? AND m.fecha BETWEEN ? AND ? AND m.trabajo >= ?
       GROUP BY m.tipo, m.categoria_id ORDER BY m.tipo, total DESC`,
    )
    .all(...args)
  const gastos_por_dia = db
    .prepare(
      `SELECT fecha, SUM(importe_centimos) AS total
       FROM fin_movimientos WHERE user_id = ? AND tipo = 'gasto' AND fecha BETWEEN ? AND ? AND trabajo >= ?
       GROUP BY fecha ORDER BY fecha`,
    )
    .all(...args)

  return c.json({ desde, hasta, por_mes, por_categoria, gastos_por_dia })
})

// --- Aportar a la casa ---

// Gasto personal (categoría "Casa") + ingreso en casa (Aportación), enlazados; borrar uno borra el otro.
finanzas.post('/aportar-casa', async (c) => {
  const user = c.get('user')
  const body = await c.req.json().catch(() => null)
  const importe = body?.importe_centimos
  if (!Number.isSafeInteger(importe) || importe <= 0) throw fail(400, 'El importe debe ser un entero de céntimos mayor que 0')
  const fecha = body.fecha ?? hoy()
  if (!isFecha(fecha)) throw fail(400, 'fecha debe ser YYYY-MM-DD')
  const nota = typeof body.nota === 'string' ? body.nota.trim() : ''
  if (nota.length > 200) throw fail(400, 'La nota admite hasta 200 caracteres')

  db.exec('BEGIN')
  try {
    db.prepare("INSERT OR IGNORE INTO fin_categorias (user_id, tipo, nombre) VALUES (?, 'gasto', 'Casa')").run(user.id)
    const cat = db
      .prepare("SELECT id FROM fin_categorias WHERE user_id = ? AND tipo = 'gasto' AND nombre = 'Casa'")
      .get(user.id) as { id: number }
    const personal = db
      .prepare(
        `INSERT INTO fin_movimientos (user_id, tipo, importe_centimos, categoria_id, fecha, nota)
         VALUES (?, 'gasto', ?, ?, ?, ?) RETURNING id`,
      )
      .get(user.id, importe, cat.id, fecha, nota || null) as { id: number }
    db.prepare("INSERT OR IGNORE INTO casa_categorias (tipo, nombre) VALUES ('ingreso', 'Aportación')").run()
    const aport = db.prepare("SELECT id FROM casa_categorias WHERE tipo = 'ingreso' AND nombre = 'Aportación'").get() as { id: number }
    const casa = db
      .prepare(
        `INSERT INTO casa_movimientos (tipo, importe_centimos, categoria_id, fecha, nota, usuario_id, movimiento_personal_id)
         VALUES ('ingreso', ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(importe, aport.id, fecha, nota || null, user.id, personal.id) as { id: number }
    db.exec('COMMIT')
    return c.json({ movimiento_personal_id: personal.id, movimiento_casa_id: casa.id }, 201)
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
})
