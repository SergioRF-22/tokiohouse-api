-- Tareas compartidas. posicion 0 = la más prioritaria.
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  texto TEXT NOT NULL,
  posicion INTEGER NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users (id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX tasks_posicion ON tasks (posicion);
