import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const path = process.env.DATABASE_PATH ?? './data/tokiohouse.db'
mkdirSync(dirname(path), { recursive: true })

export const db = new DatabaseSync(path)
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')

// Aplica en orden los .sql de migrations/ que aún no constan en schema_migrations.
function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY)')
  const dir = join(import.meta.dirname, 'migrations')
  const done = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version as string),
  )
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue
    db.exec('BEGIN')
    try {
      db.exec(readFileSync(join(dir, file), 'utf8'))
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(file)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    console.log(`migración aplicada: ${file}`)
  }
}

migrate()
