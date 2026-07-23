# DocVault - Enterprise Document Management System (DMS)

> A production-grade, self-hosted Document Management System built for complete document control, automated OCR, AI-driven metadata extraction, revision safety, and smartphone scanning.

---

## Key Features

- 🧠 **Hybrid AI & OCR Extraction**: Automatically extracts document type (Invoice, Contract, Tax, etc.), sender, recipient, document date, due date, amounts, summary, and tags using Tesseract OCR & LLM integration (Ollama / OpenAI).
- 📁 **Dual Storage & Inbound Watchfolder**: Keeps your original PDFs and images organized on disk (`storage/originals/`) while monitoring `storage/input/` for incoming network scans.
- 📱 **Mobile Camera Scanner (PWA)**: Built-in camera scanning tool with auto-crop boundary preview, contrast filters, and direct upload.
- 📄 **Interactive PDF Viewer**: Multi-page PDF previewer with zooming, page rotation, text highlighting, and irreversible redaction (schwärzen).
- ⚙️ **Automated Workflows**: Rule-based automation engine for tag assignment and due date reminders upon ingestion.
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
        | PostgreSQL    |  | Redis Queue|  | File Storage     |
        | (DB & Search) |  | (BullMQ)   |  | (Originals & Input)
        +---------------+  +------+-----+  +------------------+
                                  |
                                  v
                   +--------------+------------------+
                   |  Python AI & OCR Worker Service |
                   |  (Tesseract OCR, Ollama / LLM)  |
                   +---------------------------------+
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
4. Access the web application:
   - **Frontend UI**: [http://localhost:3000](http://localhost:3000)
   - **API Gateway**: [http://localhost:4000/api/health](http://localhost:4000/api/health)
   - **Default Admin**: `admin@dms.local` / `admin123`

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
│   │   └── services/        # Watchfolder & BullMQ Redis Producer
├── worker/                  # Python Microservice for OCR & AI
│   ├── src/
│   │   ├── ocr_engine.py    # Tesseract & PyPDF text extractor
│   │   ├── ai_extractor.py  # LLM Metadata extraction & heuristics
│   │   └── worker.py        # Redis task listener loop
└── frontend/                # React (Vite) Single Page App & PWA
    ├── src/
    │   ├── components/      # DocumentList, PDFViewer, MobileScanner, WorkflowEditor
    │   └── services/        # API client
```

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
