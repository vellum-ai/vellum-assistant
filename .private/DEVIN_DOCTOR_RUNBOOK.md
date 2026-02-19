# Devin Doctor — Ops Runbook

## What It Does
When a monitored CI workflow fails on `main`, Devin Doctor automatically:
1. Creates a Devin AI session to diagnose and fix the failure
2. Opens a per-workflow lock issue (`[devin-doctor-lock] <workflow name>`) to prevent duplicate sessions
3. When that specific workflow recovers, auto-closes its lock issue

## Monitored Workflows
- `Push Gateway Image to GCP`
- `Build and Release macOS App`
- `Publish Assistant to npm`
- `Publish CLI to npm`
- `Publish Gateway to npm`

Note: Each workflow has its own independent lock, so a failure in one workflow does not block Devin Doctor from running for a different workflow.

## How to Test
1. Go to **Actions → Devin Doctor → Run workflow** (manual dispatch)
2. This runs the full pipeline except lock creation (skipped for `workflow_dispatch`)
3. Check the step summary for context and prompt output

## How to Disable
**Quick disable** (no code change needed):
- Re-run the workflow and cancel it immediately

**Temporary disable** (code change):
- Add `if: false` to the `start-devin` job
- Or comment out the `workflow_run` trigger

**Permanent disable:**
- Delete `.github/workflows/devin-doctor.yml`

## Secrets Required
- `DEVIN_API_KEY` — If not set, the workflow skips gracefully

## Troubleshooting
- **Lock stuck open**: Manually close the `[devin-doctor-lock] <workflow name>` issue
- **Workflow failing on success path**: Check that `gh issue list` has the right permissions (`issues: write`)
- **Duplicate sessions**: Verify the lock issue exists and hasn't been manually closed
- **Cross-workflow interference**: Each workflow has its own lock — verify the lock title includes the correct workflow name
