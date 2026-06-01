# Credential Executor

Credential Execution Service (CES) package for managed credential storage and authenticated command/API execution.

## Docker

The runtime image runs as non-root user `ces` (uid 1001) by default.

The image includes the opt-in block-volume helper scripts used by vembda for Kata-family block-mode deployments. Default startup still runs as `ces` and does not invoke the helpers; vembda must wrap the service command explicitly. CES block mode uses `ces-data:/ces-data:rw;workspace:/workspace:ro`; `/ces-security` remains on a separate CES-owned security volume or equivalent platform-provisioned storage. The mount helper must run as root, then drop to the existing `ces` user with `VELLUM_BLOCK_EXEC_UID=1001` and `VELLUM_BLOCK_EXEC_GID=1001`. After raw block PVC expansion, vembda may invoke `vellum-block-volume-resize.sh` through Kubernetes exec to grow ext4 online, with pod restart as the fallback. See [Kata Block-Mode Image Contract](../docs/kata-block-mode-image-contract.md).
