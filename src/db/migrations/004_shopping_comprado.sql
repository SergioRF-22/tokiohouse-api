-- Tachado del modo compra: producto de la lista ya cogido. Se limpia al salir de la lista.
ALTER TABLE shopping_items ADD COLUMN comprado INTEGER NOT NULL DEFAULT 0 CHECK (comprado IN (0, 1));
