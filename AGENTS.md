# AGENTS.md

## Start here

Read `CONTEXT.md` before changing behavior. It defines domain terms, document lifecycle, invariants, and module seams.

Use `docs/agents/development.md` when building, testing, changing dependencies, or tracing a feature across frontend, backend, worker, and infrastructure.

Use `docs/agents/subagents.md` when delegating work or coordinating parallel agents. Each task gets one owning agent and a file-disjoint worktree scope.

Keep changes inside the owning module. Preserve document retention, ACL, audit, and encryption checks on every new document read or mutation path.

Current product direction and ordered work live in `docs/roadmap/family-production-readiness.md`.

## Repository operations

### Issue tracker

Issues live as GitHub issues on `giemic8/doc-management-system`, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
