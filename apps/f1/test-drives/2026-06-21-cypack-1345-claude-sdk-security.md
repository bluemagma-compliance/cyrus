# Test Drive: CYPACK-1345 Claude SDK Dependency Patch

**Date**: 2026-06-21
**Goal**: Validate that the Claude SDK dependency update starts an F1 agent session and renders runner/tool activity.
**Test Repo**: `/tmp/f1-test-drive-cypack-1345`
**Port**: `3601` (`3600` was already occupied by an existing F1 server)

## Verification Results

### Issue-Tracker
- [x] Issue created
- [x] Issue ID returned
- [x] Issue metadata accessible

### EdgeWorker
- [x] Server started
- [x] Session started
- [x] Worktree created
- [x] Updated tool allowlist loaded with 32 tools, including `DesignSync`
- [x] Activities tracked
- [ ] Agent processed issue to completion

### Renderer
- [x] Activity format correct
- [x] Pagination works
- [ ] Final response rendered

## Session Log

Commands run:

```bash
apps/f1/f1 init-test-repo --path /tmp/f1-test-drive-cypack-1345
CYRUS_PORT=3601 CYRUS_REPO_PATH=/tmp/f1-test-drive-cypack-1345 bun run apps/f1/server.ts
CYRUS_PORT=3601 apps/f1/f1 ping
CYRUS_PORT=3601 apps/f1/f1 status
CYRUS_PORT=3601 apps/f1/f1 create-issue --title "Add fixed window reset helper" --description "Implement a small fixed-window reset timestamp helper in the rate limiter library. Keep the change minimal and run the relevant checks."
CYRUS_PORT=3601 apps/f1/f1 start-session --issue-id issue-1
CYRUS_PORT=3601 apps/f1/f1 prompt-session --session-id session-1 --message "Use the configured F1 test repository for this issue."
CYRUS_PORT=3601 apps/f1/f1 view-session --session-id session-1 --limit 100 --offset 0
CYRUS_PORT=3601 apps/f1/f1 view-session --session-id session-1 --limit 5 --offset 5
CYRUS_PORT=3601 apps/f1/f1 stop-session --session-id session-1
```

Observed:

- F1 server started successfully and reported ready.
- Issue `DEF-1` / `issue-1` was created successfully.
- Session `session-1` started and initially requested repository selection.
- After answering the repository selection prompt, EdgeWorker routed to `F1 Test Repository`, created a worktree, and started Claude with model `sonnet`.
- The session rendered `elicitation`, `prompt`, `thought`, and `action` activities.
- Pagination returned a 5-activity page with `--limit 5 --offset 5`.
- The updated tool list was visible in server logs with 32 tools, including `DesignSync` and without `TeamCreate` / `TeamDelete`.

Blocker:

- The agent did not complete the requested code change. Filesystem tool calls repeatedly errored because the generated F1 worktree path was outside the configured allowed directory list for the session.
- The allowed directories included the original test repo path and git metadata, but not the generated F1 worktree directory where Claude was executing.
- This appears to be an F1 environment/allowed-directory setup issue rather than a dependency patch regression.

## Final Retrospective

This test drive passed the runtime startup, repository routing, session creation, tool-list loading, activity rendering, and pagination checks needed for the Claude SDK dependency patch. It did not pass the full "agent processed issue" criterion because F1 blocked filesystem access to its generated worktree.
