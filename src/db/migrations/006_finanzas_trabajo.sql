-- Etiqueta "trabajo" en movimientos y gastos fijos (0/1). Los movimientos de un gasto fijo la heredan.
ALTER TABLE fin_movimientos ADD COLUMN trabajo INTEGER NOT NULL DEFAULT 0 CHECK (trabajo IN (0, 1));
ALTER TABLE fin_gastos_fijos ADD COLUMN trabajo INTEGER NOT NULL DEFAULT 0 CHECK (trabajo IN (0, 1));
