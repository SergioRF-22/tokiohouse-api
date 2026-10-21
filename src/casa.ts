import { Hono } from 'hono'
import { db } from './db/index.ts'
import type { AppEnv } from './auth.ts'
import { fail, hoy, isFecha, isMes, parseId, siguienteMes } from './finanzas.ts'

// Finanzas de la casa: COMPARTIDAS. Cualquier usuario autenticado ve y edita todo.

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
  usuario_id: number | null
  usuario: string | null
  gasto_fijo_id: number | null
  movimiento_personal_id: number | null
}
type GastoFijo = {
  id: number
  nombre: string
  importe_centimos: number
  categoria_id: number
  categoria: string
  dia: number
  mes_inicio: string
}

const isTipo = (v: unknown): v is Tipo => v === 'ingreso' || v === 'gasto'

// Mismo mecanismo que en finanzas.ts, sin dueño: crea los movimientos que falten de cada
// gasto fijo hasta hoy y su baja. generado_hasta evita recrear los borrados; el índice
// único (gasto_fijo_id, mes) es la red de seguridad.
function materializar() {
  const fechaHoy = hoy()
  const mesActual = fechaHoy.slice(0, 7)
  const fijos = db
    .prepare(
      `SELECT id, nombre, importe_centimos, categoria_id, dia, mes_inicio, baja, generado_hasta
       FROM casa_gastos_fijos WHERE generado_hasta IS NULL OR generado_hasta < ?`,
    )
    .all(mesActual) as {
    id: number
    nombre: string
    importe_centimos: number
    categoria_id: number
    dia: number
    mes_inicio: string
    baja: string | null
    generado_hasta: string | null
  }[]
  if (fijos.length === 0) return

  const ins = db.prepare(
    `INSERT OR IGNORE INTO casa_movimientos (tipo, importe_centimos, categoria_id, fecha, nota, gasto_fijo_id)
     VALUES ('gasto', ?, ?, ?, ?, ?)`,
  )
  const upd = db.prepare('UPDATE casa_gastos_fijos SET generado_hasta = ? WHERE id = ?')
  db.exec('BEGIN')
  try {
    for (const f of fijos) {
      let mes = f.generado_hasta ? siguienteMes(f.generado_hasta) : f.mes_inicio
      let hasta = f.generado_hasta
      for (; mes <= mesActual; mes = siguienteMes(mes)) {
        const fecha = `${mes}-${String(f.dia).padStart(2, '0')}`
        if (fecha > fechaHoy || (f.baja !== null && fecha >= f.baja)) break
        ins.run(f.importe_centimos, f.categoria_id, fecha, f.nombre, f.id)
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

const categoriaDe = (id: unknown) =>
  typeof id === 'number' && Number.isSafeInteger(id)
    ? (db.prepare('SELECT id, tipo, nombre FROM casa_categorias WHERE id = ?').get(id) as Categoria | undefined)
    : undefined

export const casa = new Hono<AppEnv>()

// --- Categorías ---

casa.get('/categorias', (c) => {
  const tipo = c.req.query('tipo')
  if (tipo !== undefined && !isTipo(tipo)) throw fail(400, 'tipo debe ser ingreso o gasto')
  const categorias = db
    .prepare(
      `SELECT id, tipo, nombre FROM casa_categorias
       WHERE (? IS NULL OR tipo = ?) ORDER BY tipo, nombre COLLATE NOCASE, id`,
    )
    .all(tipo ?? null, tipo ?? null) as Categoria[]
  return c.json({ categorias })
})

casa.post('/categorias', async (c) => {
  const body = await c.req.json().catch(() => null)
  const nombre = typeof body?.nombre === 'string' ? body.nombre.trim() : ''
  if (!isTipo(body?.tipo)) throw fail(400, 'tipo debe ser ingreso o gasto')
  if (!nombre || nombre.length > 40) throw fail(400, 'El nombre debe tener entre 1 y 40 caracteres')

  try {
    const cat = db
      .prepare('INSERT INTO casa_categorias (tipo, nombre) VALUES (?, ?) RETURNING id, tipo, nombre')
      .get(body.tipo, nombre) as Categoria
    return c.json(cat, 201)
  } catch (e) {
    if (e instanceof Error && /UNIQUE/.test(e.message)) throw fail(409, 'Esa categoría ya existe')
    throw e
  }
})

// --- Movimientos ---

const MOV_SELECT = `SELECT m.id, m.tipo, m.importe_centimos, m.categoria_id, k.nombre AS categoria, m.fecha, m.nota,
    m.usuario_id, u.username AS usuario, m.gasto_fijo_id, m.movimiento_personal_id
  FROM casa_movimientos m JOIN casa_categorias k ON k.id = m.categoria_id LEFT JOIN users u ON u.id = m.usuario_id`

casa.get('/movimientos', (c) => {
  const mes = c.req.query('mes') ?? hoy().slice(0, 7)
  if (!isMes(mes)) throw fail(400, 'mes debe ser YYYY-MM')
  materializar()
  const movimientos = db
    .prepare(`${MOV_SELECT} WHERE m.mes = ? ORDER BY m.fecha DESC, m.id DESC`)
    .all(mes) as Movimiento[]
  return c.json({ movimientos })
})

casa.post('/movimientos', async (c) => {
  const body = await c.req.json().catch(() => null)
  if (!isTipo(body?.tipo)) throw fail(400, 'tipo debe ser ingreso o gasto')
  const importe = body.importe_centimos
  if (!Number.isSafeInteger(importe) || importe <= 0) throw fail(400, 'El importe debe ser un entero de céntimos mayor que 0')
  const cat = categoriaDe(body.categoria_id)
  if (!cat || cat.tipo !== body.tipo) throw fail(400, 'Categoría no válida para ese tipo')
  const fecha = body.fecha ?? hoy()
  if (!isFecha(fecha)) throw fail(400, 'fecha debe ser YYYY-MM-DD')
  const nota = typeof body.nota === 'string' ? body.nota.trim() : ''
  if (nota.length > 200) throw fail(400, 'La nota admite hasta 200 caracteres')

  const { id } = db
    .prepare(
      `INSERT INTO casa_movimientos (tipo, importe_centimos, categoria_id, fecha, nota, usuario_id)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(body.tipo, importe, cat.id, fecha, nota || null, c.get('user').id) as { id: number }
  return c.json(db.prepare(`${MOV_SELECT} WHERE m.id = ?`).get(id) as Movimiento, 201)
})

// Si es una aportación enlazada, el trigger borra también el gasto personal.
casa.delete('/movimientos/:id', (c) => {
  const { changes } = db.prepare('DELETE FROM casa_movimientos WHERE id = ?').run(parseId(c.req.param('id')))
  if (!changes) throw fail(404, 'No existe')
  return c.body(null, 204)
})

// --- Gastos fijos ---

const FIJO_SELECT = `SELECT g.id, g.nombre, g.importe_centimos, g.categoria_id, k.nombre AS categoria, g.dia, g.mes_inicio
  FROM casa_gastos_fijos g JOIN casa_categorias k ON k.id = g.categoria_id`

casa.get('/gastos-fijos', (c) => {
  const gastos_fijos = db.prepare(`${FIJO_SELECT} WHERE g.baja IS NULL ORDER BY g.dia, g.id`).all() as GastoFijo[]
  return c.json({ gastos_fijos })
})

casa.post('/gastos-fijos', async (c) => {
  const body = await c.req.json().catch(() => null)
  const nombre = typeof body?.nombre === 'string' ? body.nombre.trim() : ''
  if (!nombre || nombre.length > 60) throw fail(400, 'El nombre debe tener entre 1 y 60 caracteres')
  const importe = body.importe_centimos
  if (!Number.isSafeInteger(importe) || importe <= 0) throw fail(400, 'El importe debe ser un entero de céntimos mayor que 0')
  const cat = categoriaDe(body.categoria_id)
  if (!cat || cat.tipo !== 'gasto') throw fail(400, 'La categoría debe ser de gasto')
  const dia = body.dia
  if (!Number.isInteger(dia) || dia < 1 || dia > 28) throw fail(400, 'El día debe estar entre 1 y 28')
  const mesInicio = body.mes_inicio ?? hoy().slice(0, 7)
  if (!isMes(mesInicio)) throw fail(400, 'mes_inicio debe ser YYYY-MM')

  const { id } = db
    .prepare(
      `INSERT INTO casa_gastos_fijos (nombre, importe_centimos, categoria_id, dia, mes_inicio)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
    )
    .get(nombre, importe, cat.id, dia, mesInicio) as { id: number }
  return c.json(db.prepare(`${FIJO_SELECT} WHERE g.id = ?`).get(id) as GastoFijo, 201)
})

// "Quitar" = fecha de baja; los movimientos ya generados se quedan.
casa.post('/gastos-fijos/:id/baja', (c) => {
  const id = parseId(c.req.param('id'))
  materializar() // lo ya vencido se genera antes de cerrar
  const { changes } = db
    .prepare('UPDATE casa_gastos_fijos SET baja = ? WHERE id = ? AND baja IS NULL')
    .run(hoy(), id)
  if (!changes) throw fail(404, 'No existe')
  return c.body(null, 204)
})

// --- Saldo inicial ---

casa.put('/saldo-inicial', async (c) => {
  const body = await c.req.json().catch(() => null)
  const saldo = body?.saldo_inicial_centimos
  if (!Number.isSafeInteger(saldo)) throw fail(400, 'saldo_inicial_centimos debe ser un entero de céntimos')
  db.prepare('UPDATE casa_config SET saldo_inicial_centimos = ? WHERE id = 1').run(saldo)
  return c.json({ saldo_inicial_centimos: saldo })
})

// --- Resumen ---

casa.get('/resumen', (c) => {
  materializar()
  const fechaHoy = hoy()
  const mesActual = fechaHoy.slice(0, 7)
  const anioQ = c.req.query('anio') ?? mesActual.slice(0, 4)
  if (!/^\d{4}$/.test(anioQ)) throw fail(400, 'anio debe ser YYYY')
  const anio = anioQ

  const inicial = (db.prepare('SELECT saldo_inicial_centimos AS s FROM casa_config WHERE id = 1').get() as { s: number }).s
  const neto = (where: string, ...args: string[]) =>
    (db
      .prepare(
        `SELECT COALESCE(SUM(CASE tipo WHEN 'ingreso' THEN importe_centimos ELSE -importe_centimos END), 0) AS n
         FROM casa_movimientos WHERE ${where}`,
      )
      .get(...args) as { n: number }).n

  const saldo_actual = inicial + neto('1 = 1')

  // Media de los meses con gastos entre los últimos 12 (el actual incluido).
  const desde12 = new Date(Date.UTC(Number(mesActual.slice(0, 4)), Number(mesActual.slice(5)) - 12, 1)).toISOString().slice(0, 7)
  const { media } = db
    .prepare(
      `SELECT COALESCE(AVG(total), 0) AS media FROM (
         SELECT SUM(importe_centimos) AS total FROM casa_movimientos
         WHERE tipo = 'gasto' AND mes BETWEEN ? AND ? GROUP BY mes)`,
    )
    .get(desde12, mesActual) as { media: number }
  const gasto_medio_mensual = Math.round(media)

  const gasto_anio = (db
    .prepare("SELECT COALESCE(SUM(importe_centimos), 0) AS t FROM casa_movimientos WHERE tipo = 'gasto' AND substr(mes, 1, 4) = ?")
    .get(anio) as { t: number }).t
  const fijos_mensual_total = (db
    .prepare('SELECT COALESCE(SUM(importe_centimos), 0) AS t FROM casa_gastos_fijos WHERE baja IS NULL')
    .get() as { t: number }).t

  // Todos los meses del año; el saldo al cierre arrastra el histórico anterior.
  const filas = db
    .prepare(
      `SELECT mes,
              COALESCE(SUM(CASE WHEN tipo = 'ingreso' THEN importe_centimos END), 0) AS ingresos,
              COALESCE(SUM(CASE WHEN tipo = 'gasto' THEN importe_centimos END), 0) AS gastos
       FROM casa_movimientos WHERE substr(mes, 1, 4) = ? GROUP BY mes`,
    )
    .all(anio) as { mes: string; ingresos: number; gastos: number }[]
  const porMes = new Map(filas.map((f) => [f.mes, f]))
  let saldo = inicial + neto('mes < ?', `${anio}-01`)
  const por_mes = []
  for (let m = 1; m <= 12; m++) {
    const mes = `${anio}-${String(m).padStart(2, '0')}`
    const ingresos = porMes.get(mes)?.ingresos ?? 0
    const gastos = porMes.get(mes)?.gastos ?? 0
    saldo += ingresos - gastos
    por_mes.push({ mes, ingresos, gastos, saldo_cierre: saldo })
  }

  const por_categoria = db
    .prepare(
      `SELECT m.categoria_id, k.nombre AS categoria, SUM(m.importe_centimos) AS total
       FROM casa_movimientos m JOIN casa_categorias k ON k.id = m.categoria_id
       WHERE m.tipo = 'gasto' AND substr(m.mes, 1, 4) = ? GROUP BY m.categoria_id ORDER BY total DESC`,
    )
    .all(anio)

  const APORT = `FROM casa_movimientos m JOIN casa_categorias k ON k.id = m.categoria_id LEFT JOIN users u ON u.id = m.usuario_id
    WHERE m.tipo = 'ingreso' AND k.nombre = 'Aportación' AND substr(m.mes, 1, 4) = ?`
  const aportaciones = db
    .prepare(`SELECT m.usuario_id, u.username AS usuario, m.mes, SUM(m.importe_centimos) AS total ${APORT} GROUP BY m.usuario_id, m.mes ORDER BY m.mes, u.username`)
    .all(anio)
  const aportaciones_anio = db
    .prepare(`SELECT m.usuario_id, u.username AS usuario, SUM(m.importe_centimos) AS total ${APORT} GROUP BY m.usuario_id ORDER BY u.username`)
    .all(anio)

  // Fijos que aún no han vencido este mes (los vencidos ya son movimientos).
  const proximos_fijos = (db
    .prepare(`${FIJO_SELECT} WHERE g.baja IS NULL AND g.mes_inicio <= ? ORDER BY g.dia, g.id`)
    .all(mesActual) as GastoFijo[])
    .map((g) => ({ ...g, fecha: `${mesActual}-${String(g.dia).padStart(2, '0')}` }))
    .filter((g) => g.fecha > fechaHoy)

  return c.json({
    anio: Number(anio),
    saldo_inicial_centimos: inicial,
    saldo_actual,
    gasto_medio_mensual,
    gasto_anio,
    fijos_mensual_total,
    meses_colchon: gasto_medio_mensual > 0 ? Math.round((saldo_actual / gasto_medio_mensual) * 10) / 10 : null,
    aportacion_sugerida_persona: Math.round(gasto_medio_mensual / 2),
    por_mes,
    por_categoria,
    aportaciones,
    aportaciones_anio,
    proximos_fijos,
  })
})
