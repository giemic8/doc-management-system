# Ticket #8: [Feature] Automated Email Import via IMAP / POP3

## Type
`feature`, `automation`

## Description
Many digital invoices and receipts arrive via email. Add a polling service that connects to a dedicated mailbox (e.g. `invoices@mydomain.com`), extracts PDF attachments, and automatically ingests them into DocVault.

## Acceptance Criteria
- [ ] Admin UI config for IMAP connection settings (host, port, SSL/TLS, credentials).
- [ ] Scheduled background worker checking inbox every N minutes.
- [ ] Automatic extraction of PDF/image attachments.
- [ ] Tag extracted documents with `Source: Email` and store sender email address in metadata.
- [ ] Move or mark processed emails to an "Archived" folder in the email account.
