# DocVault - Enterprise Document Management System (DMS)

> A production-grade, self-hosted Document Management System built for complete document control, automated OCR, AI-driven metadata extraction, revision safety, and smartphone scanning.

Operational recovery: [backup and clean-host restore guide](docs/operations/backup-recovery.md).

---

## Key Features

- 🧠 **Hybrid AI & OCR Extraction**: Automatically extracts document type (Invoice, Contract, Tax, etc.), sender, recipient, document date, due date, amounts, summary, and tags using Tesseract OCR & LLM integration (Ollama / OpenAI).
- 📁 **Dual Storage & Inbound Watchfolder**: Keeps your original PDFs and images organized on disk (`storage/originals/`) while monitoring `storage/input/` for incoming network scans.
- 📱 **Mobile Camera Scanner (PWA)**: Built-in camera scanning tool with auto-crop boundary preview, contrast filters, and direct upload.
- 📄 **Interactive PDF Viewer**: Multi-page PDF previewer with zooming, page rotation, text highlighting, and irreversible redaction (schwärzen).
- ⚙️ **Automated Workflows**: Rule-based automation engine for tag assignment and due date reminders upon ingestion.
- 🗑️ **90-Day Trash & Controlled Purge**: Deleting moves documents into a 90-day trash they can be restored from; destroying content is a separate admin action with typed confirmation, blocked by legal hold, retention lock, active share links, or a missing backup.
- 🔐 **Private & Shared Family Spaces**: A private space is readable only by its owner — administrators included. Getting into somebody else's private space needs an emergency unlock: requested by a trusted contact the owner nominated in advance, approved by a second trusted person, read-only, expiring, and audited down to each document opened. Account recovery runs on the owner's own single-use recovery codes, so no admin password reset exists to work around any of it.
- 🔎 **Review Inbox & Duplicate Detection**: Extracted metadata is a proposal with a confidence, not a fact — only what clears the configured threshold is written to the document, and everything else waits in a review inbox where it can be accepted, corrected, retried, or separated. Exact duplicates are linked at ingest without writing the original a second time, similar documents are only ever flagged as candidates, and nothing is merged automatically.
- 📟 **Operations Dashboard & Alerts**: Measured health for database, Redis, storage capacity, backup and restore verification, ingestion queue age, worker, email import and the AI provider — each with its last success, current failure and the operator action that fixes it. One open incident per problem (repeats bump a counter instead of mailing again), one recovery notice when it clears, and every alert recorded locally before delivery is attempted, so a household with no mail server still sees everything.
- 🔒 **Enterprise RBAC & Revisions**: Full audit log history tracking document versions, user actions, and metadata edits.
- ⚡ **Dual Engine Microservices**: Node.js/TypeScript API Gateway + Python AI/OCR Processing Worker + PostgreSQL (`pgvector`/FTS) + Redis.

---

## System Architecture

```
+-------------------------------------------------------------------+
|               Mobile PWA / Web UI (React + Vite)                  |
+---------------------------------+---------------------------------+
                                  | REST / HTTP API
                                  v
+---------------------------------+---------------------------------+
|            Node.js / TypeScript API Gateway                       |
|           (Auth, RBAC, CRUD, Watchfolder Service)                 |
+------------------+--------------+------------------+--------------+
                   |              |                  |
                   v              v                  v
        +----------+----+  +------+-----+  +---------+--------+
        | PostgreSQL    |  | Redis      |  | File Storage     |
        | State/Search  |  | Rate limits|  | Originals/Input  |
        +-------+-------+  +------------+  +---------+--------+
                ^                                    ^
                |                                    |
                +----------+--------------+----------+
                           | AI/OCR Worker |
                           +---------------+
```

---

## Quickstart with Docker Compose

### Prerequisites
- [Docker](https://www.docker.com/) & Docker Compose installed.

### Launching the Stack
1. Clone or navigate to this repository:
   ```bash
   cd doc-management-system
   ```
2. Copy environment file:
   ```bash
   cp .env.example .env
   ```
3. Start all services in background:
   ```bash
   docker compose up -d --build
   ```
4. Create the first administrator without storing its password in the repository:
   ```bash
   export ADMIN_EMAIL=you@example.com
   read -s ADMIN_PASSWORD && export ADMIN_PASSWORD
   docker compose exec -e ADMIN_EMAIL -e ADMIN_PASSWORD backend node dist/scripts/createAdmin.js
   unset ADMIN_EMAIL ADMIN_PASSWORD
   ```
5. Access the web application:
   - **Frontend UI**: [http://localhost:3000](http://localhost:3000)
   - **API Gateway**: [http://localhost:4000/api/health](http://localhost:4000/api/health)

Production startup never creates a default administrator. Development and test resets seed
`admin@dms.local` / `admin123` only outside production.

---

## Project Structure

```
doc-management-system/
├── docker-compose.yml       # Docker Compose setup for Postgres, Redis, Backend, Worker, Frontend
├── .env.example             # Environment configuration template
├── README.md                # System documentation
├── backend/                 # Node.js TypeScript API Gateway & Storage Manager
│   ├── src/
│   │   ├── config/          # Environment & Storage settings
│   │   ├── database/        # PostgreSQL schema & auto-migrations
│   │   ├── middleware/      # Auth & RBAC
│   │   ├── routes/          # Documents, Tags, Workflows, Audit
│   │   └── services/        # Ingestion, storage, integrations, and domain modules
├── worker/                  # Python Microservice for OCR & AI
│   ├── src/
│   │   ├── ocr_engine.py    # Tesseract & PyPDF text extractor
│   │   ├── ai_extractor.py  # LLM Metadata extraction & heuristics
│   │   └── worker.py        # PostgreSQL lifecycle worker loop
└── frontend/                # React (Vite) Single Page App & PWA
    ├── src/
    │   ├── components/      # DocumentList, PDFViewer, MobileScanner, WorkflowEditor
    │   └── services/        # API client
```

---

## AI-assisted Development

Coding agents should start with [`AGENTS.md`](AGENTS.md) and [`CONTEXT.md`](CONTEXT.md). Build, test, change-routing, and cross-cutting security guidance lives in [`docs/agents/development.md`](docs/agents/development.md). Approved product work is ordered in [`docs/roadmap/family-production-readiness.md`](docs/roadmap/family-production-readiness.md).

---

## GitHub Repository Setup

To push this codebase to a new GitHub repository:

```bash
# 1. Initialize git (if not already done)
git init

# 2. Add files and commit
git add .
git commit -m "feat: initial release of production-grade Document Management System"

# 3. Create repository on GitHub (via gh CLI or GitHub UI)
gh repo create doc-management-system --public --source=. --remote=origin --push

# Or manually link your remote:
# git remote add origin git@github.com:<YOUR_USER>/doc-management-system.git
# git branch -M main
# git push -u origin main
```
