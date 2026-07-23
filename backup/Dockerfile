FROM debian:12-slim

# Install:
#   postgresql-client -> pg_dump for DB dumps
#   gnupg             -> GPG symmetric AES-256 encryption of backup artifacts
#   ca-certificates/curl -> needed to fetch the official rclone install script
#   bash, gzip, tar    -> scripting + compression/archival tools used by run-backup.sh
RUN apt-get update && apt-get install -y --no-install-recommends \
    postgresql-client \
    gnupg \
    ca-certificates \
    curl \
    unzip \
    bash \
    gzip \
    tar \
    && curl -fsSL https://rclone.org/install.sh | bash \
    && apt-get purge -y curl unzip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY scripts/ ./scripts/
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./scripts/run-backup.sh ./scripts/verify-restore.sh ./entrypoint.sh

# /backups holds timestamped local artifacts + the last-backup-status.json
# health file that the backend API reads (shared volume, see docker-compose.yml).
VOLUME ["/backups"]

ENTRYPOINT ["./entrypoint.sh"]
