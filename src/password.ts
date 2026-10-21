import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const KEYLEN = 64

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, KEYLEN, (err, key) => (err ? reject(err) : resolve(key))),
  )
}

// Formato: scrypt$<salt hex>$<hash hex>
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  return `scrypt$${salt.toString('hex')}$${(await derive(password, salt)).toString('hex')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [, salt, hash] = stored.split('$')
  if (!salt || !hash) return false
  const expected = Buffer.from(hash, 'hex')
  const actual = await derive(password, Buffer.from(salt, 'hex'))
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
