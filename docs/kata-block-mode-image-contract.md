# Kata Block-Mode Image Contract

Block mode is an opt-in deployment shape rendered by vembda. The service images do not auto-detect block storage, and their default `virtual_filesystem` startup paths do not source or execute the block-volume helpers.

In block mode, vembda exposes the raw PVC block device to the relevant container and wraps the normal service command with one of the helper scripts installed at `/usr/local/bin/`:

- `vellum-block-volume-init.sh` initializes the shared ext4 filesystem once.
- `vellum-block-volume-mount.sh -- <service command...>` mounts the ext4 root, bind-mounts service subdirectories, optionally drops privileges, and then executes the service command.
- `vellum-block-volume-resize.sh [bind-path]` verifies the raw device is ext4, runs `resize2fs`, and optionally prints `findmnt` and `df -h` evidence for a bind path after resize.

## Required Environment

vembda must set these variables for containers that invoke the helpers:

| Variable | Value |
| --- | --- |
| `VELLUM_FILESYSTEM_MODE` | `block` |
| `VELLUM_BLOCK_DEVICE` | `/dev/assistant-data` |
| `VELLUM_BLOCK_ROOT` | `/mnt/vellum-block-root` |
| `VELLUM_BLOCK_BIND_SPECS` | Semicolon-separated `source:target:ro\|rw` bind specs for app containers |
| `VELLUM_BLOCK_EXEC_UID` | Optional uid used with `VELLUM_BLOCK_EXEC_GID` by `vellum-block-volume-mount.sh` before exec |
| `VELLUM_BLOCK_EXEC_GID` | Optional gid used with `VELLUM_BLOCK_EXEC_UID` by `vellum-block-volume-mount.sh` before exec |
| `VELLUM_BLOCK_RESIZE_EVIDENCE_PATH` | Optional bind path for `vellum-block-volume-resize.sh` evidence output |

`VELLUM_BLOCK_BIND_SPECS` is not required for the init container. The helpers default `VELLUM_BLOCK_DEVICE` and `VELLUM_BLOCK_ROOT` to the values above, but vembda should render them explicitly so the pod spec is self-describing.

`VELLUM_BLOCK_EXEC_UID` and `VELLUM_BLOCK_EXEC_GID` must be set together. When present, the mount helper runs the service via `setpriv --reuid <uid> --regid <gid> --clear-groups`, so the service process does not retain root group membership after the mount work completes.

## Expected Bind Specs

| Service | `VELLUM_BLOCK_BIND_SPECS` |
| --- | --- |
| Assistant | `assistant-data:/data:rw;workspace:/workspace:rw;dockerd-data:/var/lib/docker:rw` |
| Gateway | `workspace:/workspace:rw` |
| CES | `ces-data:/ces-data:rw;workspace:/workspace:ro` |

The init helper creates these top-level directories under `VELLUM_BLOCK_ROOT`: `assistant-data`, `workspace`, `ces-data`, and `dockerd-data`. Assistant, workspace, and CES data are owned by `1001:1001`; Docker data is owned by `0:0`.

When the init helper finds an existing ext4 filesystem, it runs `vellum-block-volume-resize.sh` before mounting the shared root. It must never run `mkfs.ext4` on a device that already has a filesystem.

Gateway security material (`/gateway-security`), CES credential/security material (`/ces-security`), and other service-owned security storage must stay on separate service-owned volumes or equivalent platform-provisioned storage. They must not be initialized under, or bind-mounted from, the shared raw block volume.

## Security Boundary

The block-volume helper does not provide cryptographic isolation between subdirectories. Any container with access to the raw block device can mount the entire ext4 filesystem, so vembda must not treat bind-mounted paths as a hard security boundary. Block mode is a storage-layout optimization for Kata-family isolation, not a substitute for per-service secrets ownership or separate security volumes.

Block-mode app containers that invoke `vellum-block-volume-mount.sh` must start the helper as root so it can mount the raw block device and bind targets. For images that normally run as a non-root user, vembda must set `VELLUM_BLOCK_EXEC_UID=1001` and `VELLUM_BLOCK_EXEC_GID=1001` so the helper drops to that user before executing the service command.

## Resize Flow

After Kubernetes expands the raw block PVC, vembda may run `vellum-block-volume-resize.sh` inside a block-mode app container via Kubernetes exec to grow the ext4 filesystem online. The exec command must run with permission to access the raw block device and resize the filesystem. Pass the bind path as the first argument, or set `VELLUM_BLOCK_RESIZE_EVIDENCE_PATH`, to print `findmnt` and `df -h` evidence after `resize2fs` completes. The helper exits nonzero when the raw device is not ext4 or when `resize2fs` fails, so vembda can fall back to restarting the pod and letting init retry the resize before mounts are established.

## Image Contents

The assistant, gateway, and credential-executor runtime images include:

- Executable `vellum-block-volume-init.sh`, `vellum-block-volume-mount.sh`, and `vellum-block-volume-resize.sh` in `/usr/local/bin/`.
- `e2fsprogs` for `mkfs.ext4`, `resize2fs`, and filesystem inspection.
- `mount` and `util-linux` for `mount`, `findmnt`, and `setpriv`.
- `df` from the base image's coreutils package for resize evidence output.

The helper scripts are inert unless the container command explicitly invokes them. Normal image `CMD`, `USER`, and entrypoint behavior remains unchanged.
