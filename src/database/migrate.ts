import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { pool } from './db';
import { logger } from '../utils/logger';

// Executa todos os arquivos .sql da pasta migrations em ordem alfabética.
// Cada migration só roda uma vez — controla via tabela schema_migrations.
async function runMigrations() {
  const migrationsDir = path.join(__dirname, '../../database/migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  const client = await pool.connect();
  try {
    // Cria a tabela de controle se ainda não existir
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    for (const file of files) {
      const version = file.replace('.sql', '');

      const { rows } = await client.query(
        'SELECT version FROM schema_migrations WHERE version = $1',
        [version]
      );

      if (rows.length > 0) {
        logger.info({ version }, 'Migration já aplicada, pulando');
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

      // Cada migration roda dentro de uma transação — se falhar, não fica pela metade
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version) VALUES ($1)',
        [version]
      );
      await client.query('COMMIT');

      logger.info({ version }, 'Migration aplicada com sucesso');
    }

    logger.info('Todas as migrations concluídas');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err }, 'Falha ao aplicar migration');
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations();
