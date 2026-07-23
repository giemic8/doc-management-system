# Ticket #9: [Compliance] GoBD Retention Policy & Audit Export

## Type
`compliance`, `feature`

## Description
To ensure compliance with legal retention periods (e.g. 10 years for tax invoices in Germany/EU GoBD regulations), implement retention locking and automated audit export packages.

## Acceptance Criteria
- [ ] Retention policy rules setting retention locks on documents for N years.
- [ ] Prevent deletion or modification of locked original files until retention date expires.
- [ ] Export Audit Package: Download ZIP containing documents, metadata JSON, SHA-256 checksums, and signed audit history.
- [ ] Legal hold toggle to pause retention expiry for ongoing tax or legal audits.
