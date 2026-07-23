# Ticket #7: [UI / UX] Drag-and-Drop Batch File Upload & Bulk Metadata Editor

## Type
`ui/ux`, `feature`

## Description
Improve bulk ingestion UX by allowing users to drop 50+ files onto the web application at once, with per-file upload progress bars and multi-document bulk editing (apply tag to all selected).

## Acceptance Criteria
- [ ] Global dropzone overlay across the main dashboard interface.
- [ ] Parallel upload queue manager with concurrency limit (e.g. 5 concurrent uploads).
- [ ] Individual file upload progress bar and status indicator.
- [ ] Bulk selection mode in document list with actions: "Add Tag", "Change Type", "Delete Selected".
