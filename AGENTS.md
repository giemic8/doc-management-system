# Working in this repository

This repository deploys and operates a **paperless-ngx** archive. It holds
configuration, not an application: there is no service here to build, no
test suite to run, and no source tree to refactor.

It used to hold DocVault, a document management system written from
scratch. That system was replaced —
[ADR 0006](docs/adr/0006-paperless-ngx-replaces-docvault.md) records why, and
ADRs 0001–0005 document the decisions inside the system that no longer
exists. Do not restore code from `main` history to "fix" a gap here; a gap
is either configuration, a satellite service, or something paperless-ngx
already does.

## Shape

    docker-compose.yml    the stack: paperless, postgres, redis, gotenberg, tika, ollama
    .env.example          secrets and paths; copy to .env
    ai/{claude,ollama,off}.env
                          one LLM backend each, selected by AI_BACKEND
    backup/               GPG + rclone offsite backup and restore drill
    docs/adr/             decision records, 0006 onwards apply to this repo

## Rules that matter here

Changing `docker-compose.yml` or an `ai/*.env` means validating it:

    AI_BACKEND=claude docker compose config -q
    AI_BACKEND=ollama docker compose config -q
    AI_BACKEND=off    docker compose config -q

All three must pass — the switch is the feature, so breaking one backend
while fixing another is the failure mode to watch for.

Never invent a `PAPERLESS_*` variable name. An unknown one is ignored in
silence, so the setting appears applied and does nothing. Check it against
`docs/configuration.md` in the paperless-ngx repository first.

Secrets belong in `.env`, which is gitignored. `ai/*.env` files are
committed and must stay free of keys; `PAPERLESS_AI_LLM_API_KEY` is
injected from `AI_API_KEY` in `docker-compose.yml` for exactly that reason.

New decisions get an ADR in `docs/adr/`, numbered `000N-title-with-dashes.md`
continuing the existing sequence. The six records already there are the
template — prose that states the decision and what it costs, not a form to
fill in. Superseding one means writing the next, not editing the old.

Keep the embedding backend identical across every `ai/*.env`. It defines
the retrieval index, so a difference between them turns each backend switch
into a full reindex.
