# Setup and Teardown Scripts

Cyrus supports optional per-repository scripts that run on the worktree lifecycle:

- **`cyrus-setup.sh`** — runs when a worktree is created for an issue.
- **`cyrus-teardown.sh`** — runs immediately before a worktree is removed when an
  issue reaches a terminal state.

Both are **auto-detected** in the repository root — no configuration needed.
Commit the file to the repository and Cyrus picks it up on its next run, on
self-hosted and cloud-hosted alike.

---

## Repository Setup Script

Place a `cyrus-setup.sh` script in your repository root to run repository-specific
initialization when Cyrus creates a worktree for an issue.

### How it works

1. Place a `cyrus-setup.sh` script in your repository root.
2. When Cyrus processes an issue, it creates a new git worktree.
3. If the setup script exists, Cyrus runs it **inside the worktree directory**
   with these environment variables:
   - `LINEAR_ISSUE_ID` — the Linear issue ID
   - `LINEAR_ISSUE_IDENTIFIER` — the issue identifier (e.g., `CEA-123`)
   - `LINEAR_ISSUE_TITLE` — the issue title

### Example

```bash
#!/bin/bash
# cyrus-setup.sh — repository initialization script

# Copy environment files from a central location
cp /path/to/shared/.env packages/app/.env

# Spin up per-issue infrastructure
createdb "db_${LINEAR_ISSUE_IDENTIFIER//-/_}"

echo "Setup complete for $LINEAR_ISSUE_IDENTIFIER"
```

Make sure the script is executable: `chmod +x cyrus-setup.sh`.

### Timeout

Setup scripts have a **5-minute timeout**. Failures are logged and do not
prevent worktree creation.

---

## Repository Teardown Script

Place a `cyrus-teardown.sh` script in your repository root to run repository-specific
cleanup when an issue reaches a terminal state.

### How it works

1. Place a `cyrus-teardown.sh` script in your repository root.
2. When the Linear issue reaches a terminal state (see below), Cyrus runs the
   script **inside the issue's worktree subdirectory**, then removes the worktree.
3. Only `LINEAR_ISSUE_IDENTIFIER` is guaranteed in the environment. The id and
   title are not available on the terminal-state cleanup path — write your
   teardown script to depend only on the identifier (or on breadcrumbs left
   behind by setup; see below).

### Terminal states that trigger teardown

- ✅ Issue moved to **completed**
- ✅ Issue moved to **canceled**
- ✅ Issue **deleted**
- ❌ Issue **unassigned** — re-assignment is a normal flow, so the worktree and
  any external state are preserved. Teardown does **not** fire on unassign.

### Multi-repo issues

For issues that span multiple repositories, each repo's `cyrus-teardown.sh` runs
independently with `cwd` set to **that repo's** worktree subdirectory
(`~/.cyrus/worktrees/<issue>/<repo-name>/`). Repositories that do not ship a
teardown script are silently skipped. A failure in one repo's teardown does not
prevent the other repos' teardowns from running, nor does it block worktree
deletion.

### Example: identifier-based naming

The simplest pattern — name external resources after the issue identifier and
look them up the same way at teardown time:

```bash
#!/bin/bash
# cyrus-teardown.sh

slug="${LINEAR_ISSUE_IDENTIFIER//-/_}"
dropdb --if-exists "db_${slug}"
docker compose -p "cyrus_${slug}" down -v
```

### Example: breadcrumb file in the worktree

When resource names are not naturally identifier-keyed (random container IDs,
dynamically allocated ports, etc.), have setup leave a breadcrumb file inside
the worktree. Teardown runs **before** `rmSync`, so the file is still readable:

```bash
# cyrus-setup.sh
port=$(shuf -i 49152-65535 -n 1)
PROJECT="cyrus_${LINEAR_ISSUE_IDENTIFIER//-/_}"
docker compose -p "$PROJECT" up -d
printf '{"port": %d, "project": "%s"}\n' "$port" "$PROJECT" > .cyrus-cleanup.json
```

```bash
# cyrus-teardown.sh
[ -f .cyrus-cleanup.json ] || exit 0
project=$(jq -r .project .cyrus-cleanup.json)
docker compose -p "$project" down -v
```

### Idempotency

Cleanup may be retried (for example after a transient failure). Write the
script idempotently — use flags like `--if-exists`, `docker rm -f`, etc.

### Timeout and failure semantics

- Teardown scripts have a **2-minute timeout**.
- Failure is **non-blocking**: errors are logged and worktree deletion proceeds.
- In multi-repo issues, one repo's teardown failure does not skip any other repo's
  teardown or block the final worktree removal.

### Log leakage warning

Both setup and teardown scripts run with `stdio: "inherit"` — anything echoed
to stdout/stderr (including secrets) lands in the edge-worker logs.

Make sure the script is executable: `chmod +x cyrus-teardown.sh`.

---

## Global Setup Script

In addition to per-repo scripts, a global setup script can run for **all**
repositories when creating new worktrees.

### Configuration

Add `global_setup_script` to your `~/.cyrus/config.json`:

```json
{
  "repositories": [...],
  "global_setup_script": "/opt/cyrus/bin/global-setup.sh"
}
```

### Execution order

When creating a new worktree:

1. **Global setup script** runs first (if configured).
2. **Repository setup script** (`cyrus-setup.sh`) runs second (if present).

Both receive the same environment variables (`LINEAR_ISSUE_ID`,
`LINEAR_ISSUE_IDENTIFIER`, `LINEAR_ISSUE_TITLE`) and run in the worktree directory.

### Use cases

- Team-wide tooling that applies to all repositories
- Shared credential setup
- Common environment configuration

There is no `global_teardown_script` — cleanup is a per-repo concern handled
by `cyrus-teardown.sh`.
