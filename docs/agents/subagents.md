# Subagent Guide

Use subagents when work splits into independent investigation, implementation, or review scopes. Main agent owns plan, integration, and final verification.

## Roles

- **Investigator** — reads code and returns evidence, affected files, invariants, tests, and unresolved risks. Makes no edits.
- **Backend builder** — owns `backend/` changes for one issue.
- **Frontend builder** — owns `frontend/` changes for one issue.
- **Worker builder** — owns `worker/` changes for one issue.
- **Operations builder** — owns `backup/`, Compose, deployment, and observability changes for one issue.
- **Reviewer** — reviews combined diff against issue acceptance criteria, `CONTEXT.md` invariants, and verification results. Makes no edits unless explicitly reassigned.

## Dispatch contract

Every dispatched task states:

1. issue and concrete outcome;
2. owned files or directory;
3. files shared with other tasks and therefore read-only;
4. domain invariants that apply;
5. required checks;
6. completion report format.

Builder completion report contains changed files, behavior added, checks run, failures, and remaining risks. Investigator and reviewer reports cite exact files and lines.

## Coordination rules

- One owning agent per file. Split by module only when file scopes do not overlap.
- Schema and shared types are integration scopes owned by main agent unless one builder receives explicit ownership.
- Cross-module interface settles before parallel builders start.
- Builders consume agreed interface; they do not independently reshape it.
- Main agent integrates completed work, runs cross-module checks, and resolves semantic conflicts.
- Reviewer starts after integrated diff exists.
- Failed or incomplete checks remain visible in handoff; dependency failures are distinct from product failures.

## Default flow

```text
main agent defines issue and invariants
               |
               v
         investigator
               |
               v
 main agent settles interface and file ownership
        /       |       \
 backend     frontend   worker/operations builders
        \       |       /
          main integration
               |
               v
            reviewer
               |
               v
      main agent final verification
```

Small one-module changes skip investigator when location and interface are already clear. Single-file changes use one builder or main agent, not parallel agents.
