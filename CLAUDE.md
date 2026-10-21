# tokiohouse-api

API privada de TokioHouse (2 usuarios: Sergio y su novia). Node 22 + TypeScript + Hono 4 + SQLite (`node:sqlite`). Sin tests a propósito: app interna sencilla.

## Comandos
- `npm run dev` (tsx watch), `npm run typecheck`, `npm run build`, `npm start` (dist/)
- `npm run user:create -- <usuario> [contraseña]` crea un usuario (no hay registro público).
- Comprobaciones tras cambios: `npm run typecheck` y, si tocas rutas, una petición real contra `npm run dev`.
- Hono CLI (`npx hono --help`) está instalado, pero `request` se cuelga con esta app (abre la DB al importar): prueba contra el dev server.

## Estructura
- `src/app.ts` app Hono (CORS, CSRF, auth global) · `src/index.ts` servidor y cierre con SIGTERM
- `src/auth.ts` login/logout/me, sesiones y rate limit · `src/password.ts` scrypt
- `src/db/index.ts` conexión y migraciones · `src/db/migrations/NNN_nombre.sql` (se aplican solas al arrancar)

## Reglas
- Todo endpoint requiere sesión, excepto `POST /auth/login` y `GET /health`. Middleware de auth global (`requireSession`), no por ruta.
- Contraseñas solo hasheadas (scrypt), nunca en claro ni en logs. Cookie de sesión `HttpOnly`, `Secure` en producción, `SameSite=Lax`.
- Sin ORM: SQL con parámetros (`?`), nunca concatenando strings. Cambios de esquema = nueva migración, nunca editar una ya aplicada.
- Secretos y config solo por variables de entorno (`.env`, no se sube; `.env.example` sí). Ver `.env.example`.
- Despliegue en Coolify (Dockerfile): escucha en 0.0.0.0:`PORT`, DB en `DATABASE_PATH` (volumen `/data`), logs a stdout.
- Dependencias mínimas: pregunta antes de añadir una nueva.

## Compact instructions
Al compactar conserva: cambios de código hechos, comandos que fallaron y decisiones de diseño.
