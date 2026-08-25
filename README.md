# paperless-ngx deployment

The family archive. Replaces DocVault — see
[ADR 0006](docs/adr/0006-paperless-ngx-replaces-docvault.md) for why.

## First start

```bash
cp .env.example .env
$EDITOR .env                 # POSTGRES_PASSWORD, PAPERLESS_SECRET_KEY, AI_API_KEY
mkdir -p data media consume export
docker compose up -d
```

Then open <http://localhost:8000>. If you left `PAPERLESS_ADMIN_USER` empty,
create the first user with:

```bash
docker compose run --rm webserver createsuperuser
```

## Switching the LLM backend

One variable in `.env`, then a restart:

| `AI_BACKEND` | What runs | Extraction quality | Data leaves the house |
|---|---|---|---|
| `claude` | Anthropic API, `claude-opus-5` | best | yes, US endpoint |
| `ollama` | local `llama3.1` | noticeably weaker on German post | no |
| `off` | no LLM at all | none — OCR and search unaffected | no |

```bash
# Claude
AI_BACKEND=claude docker compose up -d

# Local
AI_BACKEND=ollama docker compose --profile ollama up -d
docker compose exec ollama ollama pull llama3.1
```

Each value selects `ai/<value>.env`. A typo names a file that does not
exist and compose fails immediately, rather than starting with the AI
quietly switched off.

Embeddings run locally (`huggingface`) under **all three** settings. That
is deliberate: the embedding backend defines the retrieval index, so
keeping it fixed means switching generation backends never forces a
reindex.

### The one thing that breaks the switch

**Leave the AI fields empty under Settings → Application Configuration.**
Values entered there are stored in the database, and the database wins over
the environment. Set the model in the admin UI once and every
`AI_BACKEND` change afterwards does nothing, with no error anywhere.

If the switch appears to have no effect, look there first.

### One hygiene note

`AI_API_KEY` is passed to the container under every setting, so with
`ollama` or `off` the Anthropic key sits in an environment that has no use
for it. Harmless, but if you switch to local for good, clear it from `.env`.

## What Claude costs

Roughly 4,000 input and 300 output tokens per document — two to four pages
of OCR text plus the tag and correspondent list in the prompt.

| Model | per document | per 1,000 documents |
|---|---|---|
| `claude-opus-5` | ~2.8 ct | ~$28 |
| `claude-haiku-4-5` | ~0.55 ct | ~$5.50 |

Change `PAPERLESS_AI_LLM_MODEL` in `ai/claude.env` to switch. Prompt caching
is not available through the OpenAI-compatible layer, so the tag list is
re-sent with every document — that is already in the figures above.

The compatibility layer also has no place for the native API's
`inference_geo`, so requests go to a US endpoint. `AI_BACKEND=ollama` is the
setting that avoids that entirely.

## Storage

`PAPERLESS_FILENAME_FORMAT` files originals as
`2026/Finanzamt/2026-03-14_Steuerbescheid.pdf`. If paperless ever goes
away, what remains on disk is a navigable archive rather than a pile of
UUIDs.

Never move files under `media/` by hand — paperless remembers the last
filename it wrote and will not find them again. Changing the format itself
needs the document renamer to run over the existing archive.

Redundancy is the filesystem's job: put `PAPERLESS_MEDIA_PATH` and
`PAPERLESS_DATA_PATH` on a ZFS mirror. That covers originals, archive
versions, indexes and the database at once, which the old application-level
dual-copy write never did.

## Backup

Snapshots are not backup. The `backup` container runs nightly and produces
three GPG-encrypted artifacts per run — the database dump, a tar of `media/`,
and a manifest carrying the artifact hashes plus the hashes of sampled
originals. Each is written to a primary directory, copied to a second local
disk with hashes compared, and uploaded offsite when `RCLONE_REMOTE` is set.

It also runs a **restore drill** on its own schedule: decrypt, restore into a
disposable database, unpack the media tree, and re-hash the sampled originals
against the manifest. A backup that cannot be restored fails visibly instead
of looking healthy.

Set `BACKUP_ENCRYPTION_KEY` and keep a copy of it somewhere other than this
machine. Without it every artifact is unrecoverable.

### Moving between paperless versions

The nightly pair restores into the *same* paperless version. To move an
archive to a newer one, use paperless's own exporter by hand:

```bash
docker compose exec webserver document_exporter ../export
```

Full procedure, including recovery on a clean host: [backup and recovery](docs/operations/backup-recovery.md).

That is deliberately not automated — it lives inside the webserver container,
paperless has no scheduler for it, and reaching it from the backup container
would mean mounting the docker socket. See
[ADR 0006](docs/adr/0006-paperless-ngx-replaces-docvault.md).

## Not here yet

Contract deadlines with the iCal feed, SEPA-QR, cancellation letters and
DATEV export. They become small services against the paperless REST API
rather than parts of the archive.
