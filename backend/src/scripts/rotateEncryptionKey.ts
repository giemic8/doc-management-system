import { query, pool } from '../database/db';
import { reencryptFile } from '../services/fileEncryption.service';

/**
 * Batch re-encrypts every encrypted document's original file with a new
 * master key, then updates its stored IV/auth tag.
 *
 * Usage:
 *   OLD_KEY=... NEW_KEY=... npx ts-node src/scripts/rotateEncryptionKey.ts
 *
 * Intentionally does not touch STORAGE_ENCRYPTION_KEY itself -- after a
 * successful run, redeploy with STORAGE_ENCRYPTION_KEY set to NEW_KEY.
 */
async function main() {
  const oldKey = process.env.OLD_KEY;
  const newKey = process.env.NEW_KEY;

  if (!oldKey || !newKey) {
    console.error('Usage: OLD_KEY=... NEW_KEY=... npx ts-node src/scripts/rotateEncryptionKey.ts');
    process.exit(1);
  }

  const result = await query(
    `SELECT id, file_path, replica_file_path, encryption_iv, encryption_auth_tag FROM documents WHERE is_encrypted = true;`
  );

  console.log(`Rotating encryption key for ${result.rows.length} encrypted document(s)...`);

  let succeeded = 0;
  let failed = 0;

  const fs = await import('fs');

  for (const doc of result.rows) {
    try {
      const tempPath = `${doc.file_path}.rotated.tmp`;
      const { iv, authTag } = await reencryptFile(doc.file_path, tempPath, doc.encryption_iv, doc.encryption_auth_tag, oldKey, newKey);

      fs.renameSync(tempPath, doc.file_path);

      // Ticket #31 — the replica must stay a byte-identical copy of the
      // primary (same ciphertext, same iv/authTag), not a separately
      // re-encrypted file, or it would become undecryptable once
      // STORAGE_ENCRYPTION_KEY is redeployed to newKey.
      if (doc.replica_file_path) {
        fs.copyFileSync(doc.file_path, doc.replica_file_path);
      }

      await query(
        `UPDATE documents
         SET encryption_iv = $1, encryption_auth_tag = $2,
             replica_verified_at = CASE WHEN $4::text IS NOT NULL THEN CURRENT_TIMESTAMP ELSE replica_verified_at END
         WHERE id = $3;`,
        [iv, authTag, doc.id, doc.replica_file_path]
      );
      succeeded++;
      console.log(`  OK   ${doc.id}`);
    } catch (err: any) {
      failed++;
      console.error(`  FAIL ${doc.id}: ${err.message}`);
    }
  }

  console.log(`Done. ${succeeded} succeeded, ${failed} failed.`);
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main();
