# Ticket #6: [Security] Encryption-at-Rest for Document Storage

## Type
`security`, `infrastructure`

## Description
Protect sensitive physical files on disk (`storage/originals/`) against unauthorized access or server theft by implementing transparent AES-256-GCM encryption-at-rest.

## Acceptance Criteria
- [ ] Support master key encryption config (via environment variable or secret manager).
- [ ] Encrypt original files during storage saving and decrypt on-the-fly during authorized file streaming.
- [ ] Unique per-file initialization vector (IV) stored securely in database.
- [ ] CLI tool for master key rotation and batch re-encryption.
