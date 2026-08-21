# Backup and recovery

DocVault backup creates three encrypted artifacts per run:

- PostgreSQL plain-SQL dump (`db-<id>.sql.gz.gpg`)
- complete storage archive (`storage-<id>.tar.gz.gpg`)
- restore manifest with artifact and sampled-original hashes (`manifest-<id>.json.gpg`)

Successful backup means encrypted artifacts exist in primary backup storage and separately mounted local replica with matching SHA-256 hashes. With `REQUIRE_OFFSITE_BACKUP=true`, success additionally requires verified upload to configured rclone remote.

## Production configuration

Copy `.env.example` to local `.env`, then replace every example secret. Never commit `.env` or `backup/rclone.conf`.

Required production settings:

```dotenv
BACKUP_ENCRYPTION_KEY=<secret from secret manager>
BACKUP_REPLICA_HOST_PATH=/mnt/second-disk/docvault-backups
BACKUP_RETENTION_DAYS=30
RCLONE_CONFIG_HOST_PATH=./backup/rclone.conf
RCLONE_REMOTE=offsite:docvault-backups/
REQUIRE_OFFSITE_BACKUP=true

SMTP_URL=smtps://smtp.example.com:465
SMTP_USERNAME=<smtp user>
SMTP_PASSWORD=<smtp password>
BACKUP_ALERT_EMAIL_TO=admin@example.com
BACKUP_ALERT_EMAIL_FROM=docvault@example.com
```

`BACKUP_REPLICA_HOST_PATH` must use another physical disk or NAS volume than application storage and Docker's `backup_status` volume. `backup/rclone.conf` contains provider credentials and is gitignored.

Backup runs immediately at container startup and then daily. Restore drill runs immediately when no prior successful drill exists and weekly thereafter. `GET /api/backup/status` exposes admin-only stages: `created`, `replicated`, `uploaded`, `retained`, `decrypted`, and `restored`. Failed jobs activate dashboard alert and attempt SMTP delivery without logging credentials.

## Manual restore drill

This command restores latest offsite backup into disposable `dms_restore_verify` database, checks expected tables, extracts storage into temporary directory, compares sampled original hashes, and deletes disposable database:

```bash
docker compose exec backup ./scripts/verify-restore.sh
```

It refuses live database URL and any restore database name outside `dms_restore_verify` prefix.

## Clean-host recovery

1. Install Docker with Compose on clean Linux/NAS host and clone same DocVault release.
2. Restore production `.env` and `backup/rclone.conf` from secret manager. Do not copy old database or application storage.
3. Start only PostgreSQL: `docker compose up -d postgres`.
4. Run backup container without scheduler and keep disposable restored database for inspection:

   ```bash
   docker compose run --rm \
     -e KEEP_RESTORE_DATABASE=true \
     --entrypoint ./scripts/verify-restore.sh backup
   ```

5. Confirm command reports database restore plus matching sampled originals. This proves offsite download, decryption key, database restoration, and original-file recovery on clean host.
6. For disaster cutover, stop all DocVault services. Download/decrypt selected artifacts into restricted temporary directory, create production database, pipe decompressed SQL into it, and extract storage archive into configured storage mount. Preserve originals and permissions. Do not restore into running production database.
7. Start backend and worker, then verify `/api/health`, document counts, several original downloads, ACL behavior, and admin backup status before admitting users.

Clean-host drill deliberately targets disposable database. Production cutover remains explicit because overwriting live database or storage is destructive and requires operator confirmation.

## Failure handling

- Dashboard: inspect admin backup status. Failed stage contains recovery direction.
- Email: verify `emailAlert.sent`; if false, fix SMTP separately while dashboard alert stays active.
- `created` failure: check database connectivity, free space, storage readability, and PostgreSQL client/server compatibility.
- `replicated` failure: check second mount availability and capacity.
- `uploaded` failure: check rclone config, offsite credentials, network, and remote capacity.
- `decrypted` failure: check encryption key and artifact integrity.
- `restored` failure: check disposable database permissions, SQL errors, archive paths, and original hash mismatch.

Do not delete last known-good artifacts while investigating. Retention removes only encrypted `.gpg` artifacts older than configured period from scoped backup directories and remote.
