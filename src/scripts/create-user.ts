import { createInterface } from 'node:readline'
import { db } from '../db/index.ts'
import { hashPassword } from '../password.ts'

const [username, argPassword] = process.argv.slice(2)
if (!username) {
  console.error('Uso: npm run user:create -- <usuario> [contraseña]')
  process.exit(1)
}

// Pide la contraseña sin mostrarla en pantalla.
function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  const out = rl as unknown as { _writeToOutput: (s: string) => void }
  out._writeToOutput = (s) => {
    if (s.startsWith(question)) process.stdout.write(question)
  }
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    }),
  )
}

const password = argPassword ?? (await prompt('Contraseña: '))
if (password.length < 8) {
  console.error('La contraseña debe tener al menos 8 caracteres')
  process.exit(1)
}

try {
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(
    username,
    await hashPassword(password),
  )
  console.log(`usuario creado: ${username}`)
} catch (e) {
  console.error(String(e).includes('UNIQUE') ? `ya existe el usuario ${username}` : e)
  process.exitCode = 1
}
db.close()
