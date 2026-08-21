import { config } from '../config';
import { pool } from '../database/db';
import { resetDevelopmentDatabase } from '../database/reset';

async function main() {
  const confirmation = process.argv
    .slice(2)
    .find((argument) => argument.startsWith('--confirm='))
    ?.slice('--confirm='.length);
  await resetDevelopmentDatabase(config.env, confirmation);
  const target = new URL(config.databaseUrl);
  console.log(`Development database reset completed: ${target.hostname}:${target.port}${target.pathname}`);
}

main()
  .catch((error) => {
    console.error('Development database reset failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
