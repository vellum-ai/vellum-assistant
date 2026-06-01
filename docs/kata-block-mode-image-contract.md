# Kata Block-Mode Image Contract

Block mode is an opt-in deployment shape rendered by vembda. The service images do not auto-detect block storage, and their default `virtual_filesystem` startup paths do not source or execute the block-volume helpers.

In block mode, vembda exposes the raw PVC block device to the relevant container and wraps the normal service command with one of the helper scripts installed at `/usr/local/bin/`:

- `vellum-block-volume-init.sh` initializes the shared ext4 filesystem once.
- `vellum-block-volume-mount.sh -- <service command...>` mounts the ext4 root, bind-mounts service subdirectories, optionally drops privileges, and then executes the service command.

## Required Environment

vembda must set these variables for containers that invoke the helpers:

| Variable | Value |
| --- | --- |
| `VELLUM_FILESYSTEM_MODE` | `block` |
| `VELLUM_BLOCK_DEVICE` | `/dev/assistant-data` |
| `VELLUM_BLOCK_ROOT` | `/mnt/vellum-block-root` |
| `VELLUM_BLOCK_BIND_SPECS` | Semicolon-separated `source:target:ro\|rw` bind specs for app containers |
| `VELLUM_BLOCK_EXEC_UID` | Optional uid used by `vellum-block-volume-mount.sh` before exec |
| `VELLUM_BLOCK_EXEC_GID` | Optional gid used by `vellum-block-volume-mount.sh` before exec |

`VELLUM_BLOCK_BIND_SPECS` is not required for the init container. The helpers default `VELLUM_BLOCK_DEVICE` and `VELLUM_BLOCK_ROOT` to the values above, but vembda should render them explicitly so the pod spec is self-describing.

## Expected Bind Specs

| Service | `VELLUM_BLOCK_BIND_SPECS` |
| --- | --- |
| Assistant | `assistant-data:/data:rw;workspace:/workspace:rw;dockerd-data:/var/lib/docker:rw` |
| Gateway | `workspace:/workspace:rw;gateway-security:/gateway-security:rw` |
| CES | `ces-data:/ces-data:rw;ces-security:/ces-security:rw;workspace:/workspace:ro` |

The init helper creates these top-level directories under `VELLUM_BLOCK_ROOT`: `assistant-data`, `workspace`, `gateway-security`, `ces-data`, `ces-security`, and `dockerd-data`. Assistant, workspace, gateway, and CES data are owned by `1001:1001`; Docker data is owned by `0:0`.

## Security Boundary

The block-volume helper does not provide cryptographic isolation between subdirectories. Any container with access to the raw block device can mount the entire ext4 filesystem, so vembda must not treat bind-mounted paths as a hard security boundary. Block mode is a storage-layout optimization for Kata-family isolation, not a substitute for per-service secrets ownership or separate security volumes where those are required.

## Image Contents

The assistant, gateway, and credential-executor runtime images include:

- Executable `vellum-block-volume-init.sh` and `vellum-block-volume-mount.sh` in `/usr/local/bin/`.
- `e2fsprogs` for `mkfs.ext4` and filesystem inspection.
- `mount` and `util-linux` for `mount`, `findmnt`, and `setpriv`.

The helper scripts are inert unless the container command explicitly invokes them. Normal image `CMD`, `USER`, and entrypoint behavior remains unchanged.
