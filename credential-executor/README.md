# Credential Executor

Credential Execution Service (CES) package for managed credential storage and authenticated command/API execution.

## Docker

The runtime image runs as non-root user `ces` (uid 1001) by default.

The image includes the opt-in block-volume helper scripts used by vembda for Kata-family block-mode deployments. Default startup still runs as `ces` and does not invoke the helpers; vembda must wrap the service command explicitly. CES block mode uses `ces-data:/ces-data:rw;ces-security:/ces-security:rw;workspace:/workspace:ro`. See [Kata Block-Mode Image Contract](../docs/kata-block-mode-image-contract.md).
