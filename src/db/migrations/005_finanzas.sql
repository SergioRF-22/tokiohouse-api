-- Mis finanzas: todo es privado de cada usuario (user_id en todas las tablas).
-- Importes en céntimos (enteros). Fechas YYYY-MM-DD, meses YYYY-MM.
CREATE TABLE fin_categorias (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('ingreso', 'gasto')),
  nombre TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, tipo, nombre)
);

-- Gasto fijo mensual. baja = fecha en que se quitó (lo ya generado se queda).
-- generado_hasta = último mes materializado: así un movimiento generado y borrado no reaparece.
CREATE TABLE fin_gastos_fijos (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  importe_centimos INTEGER NOT NULL CHECK (importe_centimos > 0),
  categoria_id INTEGER NOT NULL REFERENCES fin_categorias (id),
  dia INTEGER NOT NULL CHECK (dia BETWEEN 1 AND 28),
  mes_inicio TEXT NOT NULL,
  baja TEXT,
  generado_hasta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX fin_gastos_fijos_user ON fin_gastos_fijos (user_id);

CREATE TABLE fin_movimientos (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('ingreso', 'gasto')),
  importe_centimos INTEGER NOT NULL CHECK (importe_centimos > 0),
  categoria_id INTEGER NOT NULL REFERENCES fin_categorias (id),
  fecha TEXT NOT NULL,
  nota TEXT,
  gasto_fijo_id INTEGER REFERENCES fin_gastos_fijos (id),
  mes TEXT GENERATED ALWAYS AS (substr(fecha, 1, 7)) VIRTUAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX fin_movimientos_user_fecha ON fin_movimientos (user_id, fecha);
-- Un movimiento por gasto fijo y mes: la materialización es idempotente.
CREATE UNIQUE INDEX fin_movimientos_fijo_mes ON fin_movimientos (gasto_fijo_id, mes) WHERE gasto_fijo_id IS NOT NULL;
