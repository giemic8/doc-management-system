# Family Production Readiness Roadmap

Status: approved design, published, implementation pending.

GitHub epic: [#28 — Family production readiness](https://github.com/giemic8/doc-management-system/issues/28).

| Work item | GitHub issue |
| --- | --- |
| Migration baseline | [#29](https://github.com/giemic8/doc-management-system/issues/29) |
| Ingestion state machine | [#30](https://github.com/giemic8/doc-management-system/issues/30) |
| Dual-copy durability | [#31](https://github.com/giemic8/doc-management-system/issues/31) |
| Backup and restore verification | [#32](https://github.com/giemic8/doc-management-system/issues/32) |
| Trash and purge | [#33](https://github.com/giemic8/doc-management-system/issues/33) |
| Family spaces | [#34](https://github.com/giemic8/doc-management-system/issues/34) |
| Review and duplicates | [#35](https://github.com/giemic8/doc-management-system/issues/35) |
| AI governance | [#36](https://github.com/giemic8/doc-management-system/issues/36) |
| Operations dashboard | [#37](https://github.com/giemic8/doc-management-system/issues/37) |
| Family mode | [#38](https://github.com/giemic8/doc-management-system/issues/38) |
| Release qualification | [#39](https://github.com/giemic8/doc-management-system/issues/39) |
| Google OAuth connector and Calendar read (Google track) | [#41](https://github.com/giemic8/doc-management-system/issues/41) |
| Gmail attachment ingestion (Google track) | [#42](https://github.com/giemic8/doc-management-system/issues/42) |

## Product target

DocVault becomes self-hosted family document system for NAS or Linux server, accessed through home network or VPN. Private and shared spaces coexist. Original-file durability outranks feature growth. Existing advanced features remain available behind simplified default experience.

No real user data exists yet. Initial schema may be rebuilt, but every schema change after baseline uses versioned migrations.

## Product decisions

- Browser upload, watchfolder, and email import share one ingestion module.
- Document lifecycle is `received`, `durable`, `processing`, `review`, `ready`, `failed`, or `trashed`.
- Acknowledged upload has two independent durable copies.
- Storage follows two local copies plus encrypted offsite backup; restore is tested automatically.
- Exact duplicates link by hash. Similar documents require review.
- High-confidence AI may assign document type and tags. Rights, sharing, deadlines, and deletion require user confirmation.
- RAG answers require document evidence; missing evidence produces no answer.
- Remote AI requires explicit global activation, no provider training, defined deletion, and EU processing.
- Private spaces support audited emergency access. Admin infrastructure access does not silently grant content access.
- Deleted documents remain recoverable for 90 days.
- Deadlines notify through application, email, and calendar feed.
- PWA remains mobile client.

## Ordered issues

### 1. Establish migration baseline and resettable development environment

Create versioned schema migration mechanism, fresh-database bootstrap, and one-command development reset. Current database may be discarded.

Acceptance:

- Empty database reaches current schema through migrations.
- Migration history records applied versions.
- Fresh reset seeds development admin only outside production.
- Backend integration tests document PostgreSQL/pgvector and Redis prerequisites.

### 2. Introduce canonical ingestion state machine

Create deep ingestion module used by upload, watchfolder, and email adapters. PostgreSQL remains authoritative state store. Remove ambiguous BullMQ signaling or add real consumer; keep one processing model.

Acceptance:

- Every source produces same document record and lifecycle transitions.
- Retries are idempotent.
- Failed processing has recorded reason and retry path.
- State transitions are tested through ingestion interface.

Depends on: 1.

### 3. Guarantee dual-copy original durability

Add storage module that acknowledges ingestion only after two independent writes verify matching hashes. Define rollback and recovery for partial writes.

Acceptance:

- Upload is not acknowledged before both copies verify.
- Partial failure leaves recoverable state and actionable error.
- Read path can recover from one unavailable copy.
- Durability behavior has fault-injection tests.

Depends on: 2.

### 4. Implement 3-2-1 backup and automated restore verification

Extend backup module for two local copies, encrypted offsite copy, retention policy, and scheduled restore drill.

Acceptance:

- Backup status distinguishes created, uploaded, decrypted, and restored.
- Restore drill verifies database plus sampled original hashes.
- Failure triggers admin email and dashboard alert.
- Recovery procedure works on clean host.

Depends on: 3.

### 5. Add 90-day trash and controlled purge

Replace direct deletion with trash lifecycle. Purge honors legal hold, retention, share state, versions, and backup policy.

Acceptance:

- Normal delete moves document to `trashed`.
- Authorized user can restore within 90 days.
- Purge requires explicit authorization and creates audit event.
- Search, RAG, analytics, and feeds exclude trashed documents.

Depends on: 1.

### 6. Add private and shared family spaces with emergency access

Model ownership and shared membership independently from tag ACLs. Add audited, time-bounded emergency access requiring second trusted person.

Acceptance:

- Private content is unreadable to normal family admins.
- Shared-space membership grants explicit access.
- Emergency access requires two-person approval, expires, and is audited.
- Search, RAG, shares, exports, and files apply same visibility rules.

Depends on: 1.

### 7. Build review inbox, confidence policy, and duplicate detection

Store extraction confidence. Auto-accept high-confidence type/tag results, route uncertain results and similar documents to review.

Acceptance:

- Confidence thresholds are configurable and tested.
- Exact hash duplicates link without second original write.
- Similarity detection never merges automatically.
- Reviewer can accept, correct, retry, or separate candidates.

Depends on: 2 and 3.

### 8. Enforce AI governance and evidence-only answers

Centralize provider policy, content minimization, audit metadata, and grounded RAG behavior.

Acceptance:

- Remote provider is disabled until explicit activation.
- Configuration records provider policy and region declaration.
- Audit records provider, purpose, document IDs, and sent character count without storing prompts containing document text.
- RAG returns citations or explicit insufficient-evidence result.
- Rights, shares, deadlines, and deletion remain human-confirmed.

Depends on: 6 and 7.

### 9. Add actionable operations dashboard and alerts

Combine storage, backup, ingestion, worker, email-import, and AI-provider health. Send concise admin email on actionable failure.

Acceptance:

- Dashboard shows last success, current failure, queue age, capacity, and recovery action.
- Alerts deduplicate repeated incidents and report recovery.
- Static storage display is replaced with measured values.
- Health checks cover dependency degradation, not only process uptime.

Depends on: 2 and 4.

### 10. Ship simplified family mode

Make documents, inbox, search, scanner, deadlines, and family spaces primary navigation. Move DATEV, GoBD, ACL, webhooks, and infrastructure details under advanced/admin settings.

Acceptance:

- API failure shows explicit offline/error state instead of demo documents.
- Core family tasks work on desktop and installed PWA.
- Advanced features remain reachable by authorized users.
- Scanner requires preview confirmation before upload.

Depends on: 6, 7, and 9.

### 11. Qualify release through failure tests and soak period

Run production-like NAS/Linux deployment for four weeks after automated release gates pass.

Acceptance:

- Upload, duplicate, retry, disk-loss, database-loss, restore, ACL, emergency-access, trash, purge, and provider-outage scenarios pass.
- Backup restore succeeds on clean host.
- No unresolved critical or high-severity data-integrity/security defects.
- Four-week run records availability, failed jobs, recovery time, and storage growth.

Depends on: 4, 5, 8, 9, and 10.

## Google integration track

Tracked here for visibility, deliberately **outside the eleven release gates**. Connecting Google is feature expansion, which the delivery policy below pauses until gate 11 passes. These two issues are listed so the coupling to gate 2 is explicit rather than discovered during implementation.

### Google OAuth connector and Calendar read — [#41](https://github.com/giemic8/doc-management-system/issues/41)

OAuth2 authorization against a Google Cloud project, per-user linked accounts, encrypted refresh/access tokens, and Google Calendar read. Adds no ingestion path, so it does not touch gate 2.

Unblocked. Buildable independently of the readiness gates.

Open risk: `gmail.readonly` is a restricted scope. Under "Testing" publishing status refresh tokens expire after seven days, which breaks unattended polling. Resolving this decides whether Google mail import can run unattended at all.

### Gmail attachment ingestion — [#42](https://github.com/giemic8/doc-management-system/issues/42)

Gmail messages matching a configurable search query are read and their attachments filed as documents. Idempotency lives in a `gmail_message_imports` ledger rather than in mailbox state, so `gmail.readonly` suffices and the mailbox stays unmodified.

Depends on: 2 (Gmail is a fourth ingestion adapter, alongside browser upload, watchfolder, and IMAP), and #41.

Recorded as native GitHub `blocked by` dependencies on #42. Building it before gate 2 would add a third hand-rolled copy of the ingest-and-enqueue sequence and write documents in a lifecycle state that gate 2 invalidates.

Also relates to 6: with per-user Google accounts, an imported document needs a space/tag assignment for tag ACLs to scope it.

## Dependency graph

```text
1 Migration baseline
├── 2 Ingestion state machine
│   └── 3 Dual-copy durability
│       ├── 4 Backup + restore drill
│       └── 7 Review + duplicates
├── 5 Trash + purge
└── 6 Family spaces + emergency access
    └── 8 AI governance (also needs 7)

9 Operations dashboard needs 2 + 4
10 Family mode needs 6 + 7 + 9
11 Release qualification needs 4 + 5 + 8 + 9 + 10

Google track (outside the release gates)
#41 Google OAuth connector + Calendar read -- no gate dependency
└── #42 Gmail attachment ingestion -- needs 2 and #41
```

## Delivery policy

Feature expansion pauses until issue 11 passes. The Google integration track is the recorded exception: it is scheduled by explicit decision, not by this policy, and #42 stays gated on issue 2 regardless. Each issue uses module-disjoint subagents per `docs/agents/subagents.md`, then integrated review. Issue acceptance criteria are release gates, not optional guidance.
