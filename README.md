# tokiohouse-api

API privada de TokioHouse para 2 personas. Node 22 + TypeScript + Hono 4 + SQLite (`node:sqlite`, sin dependencias nativas).

## Arranque local (PowerShell)

```powershell
npm install
Copy-Item .env.example .env      # ajusta lo que necesites
npm run user:create -- sergio    # pide la contraseña (mín. 8 caracteres)
npm run user:create -- <novia>
npm run dev                      # http://localhost:3000, GET /health
```

Las migraciones (`src/db/migrations/*.sql`) se aplican solas al arrancar y también con `user:create`.
El fichero SQLite se crea en `DATABASE_PATH` (por defecto `./data/tokiohouse.db`).

## Scripts

| Script | Qué hace |
|---|---|
| `npm run dev` | servidor con recarga (tsx watch) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | compila a `dist/` y copia las migraciones |
| `npm start` | ejecuta `dist/index.js` |
| `npm run user:create -- <usuario> [contraseña]` | crea un usuario |

## Endpoints

`GET /health` (público) · `POST /auth/login` `{username, password}` (público, 10 intentos/15 min por IP) · `POST /auth/logout` · `GET /auth/me`. Todo lo demás exige la cookie de sesión `sid`.

## Variables de entorno

| Variable | Por defecto | Descripción |
|---|---|---|
| `PORT` | `3000` | puerto (escucha en `0.0.0.0`) |
| `DATABASE_PATH` | `./data/tokiohouse.db` | fichero SQLite (en Coolify: `/data/tokiohouse.db`) |
| `CORS_ORIGIN` | `http://localhost:5173` | origen del front permitido (con credenciales) |
| `NODE_ENV` | — | `production` activa la cookie `Secure` |

## Despliegue (Coolify)

Dockerfile multi-stage `node:22-alpine`. Monta un volumen persistente en `/data`, define `CORS_ORIGIN=https://tokiohouse.vocadiet.es` y `NODE_ENV=production`, y usa `/health` como health check. Los usuarios se crean desde el terminal del contenedor en Coolify: `node dist/scripts/create-user.js <usuario>`. SIGTERM cierra la DB; sin rolling updates (SQLite).
