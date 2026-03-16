import { Pool, PoolClient } from 'pg';
import { logger } from '../utils/logger';

// Pool de conexões com o banco — reutiliza conexões em vez de abrir uma nova a cada query
const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'fintech_split',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  max:      Number(process.env.DB_POOL_MAX) || 20,
  idleTimeoutMillis:    30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('connect', () => {
  logger.debug('Nova conexão com o banco estabelecida');
});

pool.on('error', (err) => {
  logger.error({ err }, 'Erro inesperado no pool do banco');
});

export { pool };
export type { PoolClient };

// Executa uma função dentro de uma transação.
// Faz COMMIT se tudo correr bem, ROLLBACK se der erro — automático.
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Verifica se o banco está acessível — usado no health check
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
