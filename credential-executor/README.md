# Credential Executor

Credential Execution Service (CES) package for managed credential storage and authenticated command/API execution.

## Docker

The runtime image runs as non-root user `ces` (uid 1001) by default.

For Kata-family block-mode deployments, see the canonical [Kata Block-Mode Image Contract](../docs/kata-block-mode-image-contract.md). CES block mode uses the non-security bind specs `ces-data:/ces-data:rw;workspace:/workspace:ro`; `/ces-security` remains on a separate CES-owned security volume or equivalent platform-provisioned storage.
