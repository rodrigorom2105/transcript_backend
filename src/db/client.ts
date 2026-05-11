import { Pool } from 'pg';
import { config } from '../config';

export const db = new Pool({ connectionString: config.DATABASE_URL });

db.on('error', (err) => {
  console.error('Postgres pool error:', err);
});
