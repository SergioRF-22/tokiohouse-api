-- Finanzas casa: COMPARTIDAS, cualquier usuario autenticado ve y edita todo.
-- usuario_id solo indica el autor. Importes en céntimos; fechas YYYY-MM-DD.
CREATE TABLE casa_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  saldo_inicial_centimos INTEGER NOT NULL
);
INSERT INTO casa_config (id, saldo_inicial_centimos) VALUES (1, 290000);

CREATE TABLE casa_categorias (
  id INTEGER PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('ingreso', 'gasto')),
  nombre TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tipo, nombre)
);
INSERT INTO casa_categorias (tipo, nombre) VALUES
  ('gasto', 'Luz'), ('gasto', 'Agua'), ('gasto', 'Hipoteca'), ('gasto', 'Alarma'),
  ('gasto', 'Limpiadora'), ('gasto', 'Seguros'), ('gasto', 'Comunidad'), ('gasto', 'Otros'),
  ('ingreso', 'Aportación'), ('ingreso', 'Otros');

-- Igual que fin_gastos_fijos, sin dueño. generado_hasta = último mes materializado.
CREATE TABLE casa_gastos_fijos (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  importe_centimos INTEGER NOT NULL CHECK (importe_centimos > 0),
  categoria_id INTEGER NOT NULL REFERENCES casa_categorias (id),
  dia INTEGER NOT NULL CHECK (dia BETWEEN 1 AND 28),
  mes_inicio TEXT NOT NULL,
  baja TEXT,
  generado_hasta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- movimiento_personal_id: el gasto personal "Casa" enlazado a una aportación (ver trigger).
CREATE TABLE casa_movimientos (
  id INTEGER PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('ingreso', 'gasto')),
  importe_centimos INTEGER NOT NULL CHECK (importe_centimos > 0),
  categoria_id INTEGER NOT NULL REFERENCES casa_categorias (id),
  fecha TEXT NOT NULL,
  nota TEXT,
  usuario_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  gasto_fijo_id INTEGER REFERENCES casa_gastos_fijos (id),
  movimiento_personal_id INTEGER REFERENCES fin_movimientos (id) ON DELETE CASCADE,
  mes TEXT GENERATED ALWAYS AS (substr(fecha, 1, 7)) VIRTUAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX casa_movimientos_fecha ON casa_movimientos (fecha);
CREATE UNIQUE INDEX casa_movimientos_fijo_mes ON casa_movimientos (gasto_fijo_id, mes) WHERE gasto_fijo_id IS NOT NULL;
CREATE UNIQUE INDEX casa_movimientos_personal ON casa_movimientos (movimiento_personal_id) WHERE movimiento_personal_id IS NOT NULL;

-- Borrar el movimiento personal borra el de casa (ON DELETE CASCADE); este trigger cubre el sentido contrario.
CREATE TRIGGER casa_movimientos_borra_personal AFTER DELETE ON casa_movimientos
WHEN OLD.movimiento_personal_id IS NOT NULL
BEGIN
  DELETE FROM fin_movimientos WHERE id = OLD.movimiento_personal_id;
END;
