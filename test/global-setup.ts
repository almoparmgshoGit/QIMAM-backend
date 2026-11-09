import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import 'dotenv/config';
import { Client } from 'pg';

async function dropSchema(url: string, schema: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await client.end();
}

/**
 * Applies the real migrations to a separate schema, so the tests never touch real data. The name is
 * unique to this run, so a run stopping or starting at the same time can't remove another's tables.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const directUrl = process.env.DIRECT_URL;
  if (!directUrl) throw new Error('DIRECT_URL is required');

  const schema = `qimam_test_${randomBytes(6).toString('hex')}`;
  // Test workers start after this and inherit it.
  process.env.DATABASE_SCHEMA = schema;

  const testUrl = new URL(directUrl);
  testUrl.searchParams.set('schema', schema);
  execSync('npx prisma migrate deploy', { env: { ...process.env, DIRECT_URL: testUrl.toString() }, stdio: 'ignore' });

  const client = new Client({ connectionString: directUrl });
  await client.connect();
  await client.query(`SET search_path TO "${schema}"`);
  await client.query(readFileSync(join(import.meta.dirname, 'reference-data.sql'), 'utf8'));
  await client.end();

  return () => dropSchema(directUrl, schema);
}
