FROM postgres:16-bookworm

# Install:
#   PostgreSQL 16 client comes from base image and matches runtime database.
#   gnupg             -> GPG symmetric AES-256 encryption of backup artifacts
#   ca-certificates/curl -> rclone install plus SMTP failure alerts
#   jq, coreutils        -> atomic status JSON and SHA-256 verification
#   bash, gzip, tar    -> scripting + compression/archival tools used by run-backup.sh
RUN apt-get update && apt-get install -y --no-install-recommends \
    gnupg \
    ca-certificates \
    curl \
    unzip \
    jq \
    coreutils \
    bash \
    gzip \
    tar \
    && curl -fsSL https://rclone.org/install.sh | bash \
    && apt-get purge -y unzip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY scripts/ ./scripts/
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./scripts/*.sh ./entrypoint.sh

# /backups holds timestamped local artifacts + the last-backup-status.json
# health file that the backend API reads (shared volume, see docker-compose.yml).
VOLUME ["/backups"]

ENTRYPOINT ["./entrypoint.sh"]
