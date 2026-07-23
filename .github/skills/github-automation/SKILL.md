---
name: github-automation
description: Comprehensive skill for automating GitHub workflows including repository management, issue tracking, PR creation, code reviews, release management, and GitHub Actions CI/CD workflows using the gh CLI. Activate when the user asks to manage GitHub repos, issues, pull requests, workflows, or releases.
---

# GitHub Automation Skill

This skill equips AI agents with comprehensive capabilities to interact with GitHub using the official GitHub CLI (`gh`), git, and GitHub API patterns.

---

## 🛠 Core Tooling: GitHub CLI (`gh`)

The GitHub CLI (`gh`) is the primary tool for GitHub automation. Always check authentication status before executing operations:

```bash
gh auth status
```

If not logged in, inform the user to run `gh auth login`.

---

## 📁 1. Repository Management

### Create a New Repository
```bash
# Create local repo and push to GitHub (public)
gh repo create <repo-name> --public --source=. --remote=origin --push

# Create private repository without pushing immediately
gh repo create <repo-name> --private
```

### Repository Inspection & Cloning
```bash
# View repo details
gh repo view <owner>/<repo>

# Clone repository
gh repo clone <owner>/<repo>
```

---

## 🎫 2. Issue Management

### Create an Issue
```bash
# Direct command with title and body
gh issue create --title "[Feature] Title" --body "Detailed description" --label "enhancement"

# From a markdown body file (recommended for long bodies)
gh issue create --title "[Bug] Issue Title" --body-file path/to/body.md --label "bug"
```

### Batch Issue Creation Pattern
To create multiple issues cleanly:
1. Prepare issue markdown files in `.github/tickets/` or temporary files.
2. Iterate and invoke `gh issue create`:
```bash
gh issue create --title "Issue Title 1" --body-file .github/tickets/01.md
gh issue create --title "Issue Title 2" --body-file .github/tickets/02.md
```

### List and Filter Issues
```bash
# List open issues
gh issue list --limit 20

# Filter issues by label or state
gh issue list --label "bug" --state open
```

### Close or Reopen Issue
```bash
gh issue close <issue-number> --comment "Resolved in commit xyz"
gh issue reopen <issue-number>
```

---

## 🔀 3. Pull Request Management

### Create a Pull Request
```bash
# Create PR from current branch into main
gh pr create --title "feat: Add user authentication" --body "Implements JWT login and RBAC." --base main

# Create draft PR
gh pr create --title "draft: Refactor storage engine" --body "Work in progress" --draft
```

### Review and Merge PR
```bash
# View PR diff
gh pr diff <pr-number>

# Approve and merge PR
gh pr review <pr-number> --approve
gh pr merge <pr-number> --squash --delete-branch
```

---

## 🚀 4. Release Management

### Create a Release with Release Notes
```bash
# Create tag and release
gh release create v1.0.0 --title "v1.0.0 Production Release" --notes "Initial release including core DMS engine and PWA."

# Create release with build artifacts
gh release create v1.0.0 ./dist/bundle.zip --title "v1.0.0" --generate-notes
```

---

## ⚙️ 5. GitHub Actions Workflows

### View Workflow Runs & Status
```bash
# List recent workflow runs
gh run list

# View logs for a specific run
gh run view <run-id> --log
```

### Trigger a Manual Workflow (`workflow_dispatch`)
```bash
gh workflow run deploy.yml -f environment=production
```

---

## 💡 Best Practices

1. **Always Use `--body-file` for Long Content**: Avoid escaping multiline strings in bash; write formatted markdown files and pass them via `--body-file`.
2. **Standardized Labels**: Use standard labels: `enhancement`, `bug`, `documentation`, `security`, `ai`, `ui/ux`, `performance`, `compliance`.
3. **BypassSandbox Permission**: Running `gh` CLI commands in sandboxed environments may require standard sandbox network or bypass permissions (`BypassSandbox: true`) if network interaction is blocked.
