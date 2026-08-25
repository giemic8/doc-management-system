# Backup and recovery

Each backup run produces three GPG-encrypted artifacts:

- PostgreSQL plain-SQL dump — `db-<id>.sql.gz.gpg`
- complete paperless media tree — `media-<id>.tar.gz.gpg`
- manifest with artifact hashes and sampled-original hashes — `manifest-<id>.json.gpg`

A run counts as successful when both the primary directory and the separately
mounted local replica hold the artifacts with matching SHA-256 hashes. With
`REQUIRE_OFFSITE_BACKUP=true` it additionally requires a verified rclone upload.

The scheduled backup does **not** use paperless's `document_exporter` — see
[ADR 0006](../adr/0006-paperless-ngx-replaces-docvault.md) for why, and
"Moving to a newer paperless version" below for when you do want it.

## Configuration

Copy `.env.example` to `.env` and replace every secret. Never commit `.env` or
`backup/rclone.conf`.

The settings that decide whether this is really a 3-2-1 backup:

- `BACKUP_ENCRYPTION_KEY` — **keep a copy off this machine.** Losing it makes
  every artifact unrecoverable, including the offsite ones.
- `BACKUP_REPLICA_HOST_PATH` — must be a different physical disk than
  `PAPERLESS_MEDIA_PATH`. Left at its default it sits beside the archive, and
  the second copy is not a second copy.
- `RCLONE_REMOTE` plus a real `backup/rclone.conf` — the third, offsite copy.
  Empty means local-only; set `REQUIRE_OFFSITE_BACKUP=true` to turn a missing
  remote into a hard failure rather than a skipped stage.
- `BACKUP_ALERT_EMAIL_TO` and `SMTP_URL` — without them a failure is only in
  the container log.

## The restore drill

`verify-restore.sh` runs on `RESTORE_VERIFY_INTERVAL_SECONDS` (weekly by
default) and proves the backup is restorable rather than merely present:

1. Fetch the newest artifacts — from the offsite remote when configured,
   otherwise from the primary directory.
2. Decrypt, check both archive hashes against the manifest, and reject any
   archive containing an absolute or `..` path.
3. Restore the dump into a disposable database. The name must match
   `paperless_restore_verify`, and the live `DATABASE_URL` is refused as a
   target, so a misconfiguration cannot overwrite the archive.
4. Unpack the media tree and re-hash `RESTORE_SAMPLE_SIZE` originals against
   the manifest. Every sampled file must match.

Run it by hand at any time:

```bash
docker compose exec backup ./scripts/verify-restore.sh
```

## Recovery on a clean host

1. Install Docker, clone this repository, `cp .env.example .env` and restore
   every secret — above all `BACKUP_ENCRYPTION_KEY` and `POSTGRES_PASSWORD`.
2. Fetch the newest `db-`, `media-` and `manifest-` artifacts from the offsite
   remote.
3. Decrypt all three:
   ```bash
   gpg --batch --pinentry-mode loopback --passphrase-file <key-file> \
       --decrypt --output db.sql.gz db-<id>.sql.gz.gpg
   ```
4. Verify each against the manifest with `sha256sum --check` before trusting it.
5. Start `db` alone, create the `paperless` database, and load the dump.
6. Unpack the media archive into `PAPERLESS_MEDIA_PATH`.
7. Start the rest of the stack. Confirm the document count in the UI matches
   the count in the restored database, then re-run the search index:
   ```bash
   docker compose exec webserver document_index reindex
   ```

The search and embedding indexes live under `data/` and are **not** in the
backup, by design: both are derived from the database and the media tree and
are cheaper to rebuild than to carry.

## Moving to a newer paperless version

The nightly pair restores into the same paperless version. To migrate an
archive across versions, export it in paperless's own portable format first:

```bash
docker compose exec webserver document_exporter ../export --delete
```

`--delete` keeps the export directory a mirror rather than letting it grow.
The result is a self-describing bundle that `document_importer` reads into a
different version. Do this before a major upgrade, not after one has failed.
