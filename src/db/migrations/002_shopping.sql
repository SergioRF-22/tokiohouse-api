-- Productos de la compra. en_bolsa = catálogo de frecuentes; posicion no nula = está en la lista.
CREATE TABLE shopping_items (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  categoria TEXT NOT NULL,
  en_bolsa INTEGER NOT NULL DEFAULT 0 CHECK (en_bolsa IN (0, 1)),
  posicion INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (en_bolsa = 1 OR posicion IS NOT NULL)
);

CREATE INDEX shopping_items_posicion ON shopping_items (posicion);
