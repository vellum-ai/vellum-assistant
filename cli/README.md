# @vellumai/cli

CLI tools for provisioning and managing Vellum assistant instances.

## Installation

This package is used internally by the [`vel`](https://github.com/vellum-ai/vellum-assistant-platform/tree/main/vel) CLI. You typically don't need to install it directly.

To run it standalone with [Bun](https://bun.sh):

```bash
bun run ./src/index.ts <command> [options]
```

## Commands

### `hatch`

Provision a new assistant instance and bootstrap the Vellum runtime on it.

```bash
vellum-cli hatch [species] [options]
```

#### Species

| Species    | Description                                 |
| ---------- | ------------------------------------------- |
| `vellum`   | Default. Provisions the Vellum assistant runtime. |
| `openclaw` | Provisions the OpenClaw runtime with gateway. |

#### Options

| Option              | Description |
| ------------------- | ----------- |
| `-d`                | Detached mode. Start the instance in the background without watching startup progress. |
| `--name <name>`     | Use a specific instance name instead of an auto-generated one. |
| `--remote <target>` | Where to provision the instance. One of: `local`, `gcp`, `aws`, `custom`. Defaults to `local`. |

#### Remote Targets

- **`local`** -- Starts a local daemon on your machine via `bunx vellum daemon start`.
- **`gcp`** -- Creates a GCP Compute Engine VM (`e2-standard-4`: 4 vCPUs, 16 GB) with a startup script that bootstraps the assistant. Requires `gcloud` authentication and `GCP_PROJECT` / `GCP_DEFAULT_ZONE` environment variables.
- **`aws`** -- Provisions an AWS instance.
- **`custom`** -- Provisions on an arbitrary SSH host. Set `VELLUM_CUSTOM_HOST` (e.g. `user@hostname`) to specify the target.

#### Environment Variables

| Variable              | Required For | Description |
| --------------------- | ------------ | ----------- |
| `ANTHROPIC_API_KEY`   | All             | Anthropic API key passed to the assistant runtime. |
| `GCP_PROJECT`         | `gcp`        | GCP project ID. Falls back to the active `gcloud` project. |
| `GCP_DEFAULT_ZONE`    | `gcp`        | GCP zone for the compute instance. |
| `VELLUM_CUSTOM_HOST`  | `custom`     | SSH host in `user@hostname` format. |

#### Examples

```bash
# Hatch a local assistant (default)
vellum-cli hatch

# Hatch a vellum assistant on GCP
vellum-cli hatch vellum --remote gcp

# Hatch an openclaw assistant on GCP in detached mode
vellum-cli hatch openclaw --remote gcp -d

# Hatch with a specific instance name
vellum-cli hatch --name my-assistant --remote gcp

# Hatch on a custom SSH host
VELLUM_CUSTOM_HOST=user@10.0.0.1 vellum-cli hatch --remote custom
```

When hatching on GCP in interactive mode (without `-d`), the CLI displays an animated progress TUI that polls the instance's startup script output in real time. Press `Ctrl+C` to detach -- the instance will continue running in the background.

### `retire`

Delete a provisioned assistant instance.

```bash
vellum-cli retire <name> [options]
```

#### Options

| Option              | Description |
| ------------------- | ----------- |
| `--remote <target>` | Cloud provider of the instance. One of: `local`, `gcp`, `aws`, `custom`. Defaults to `gcp`. |

#### Remote Targets

- **`gcp`** -- Deletes a GCP Compute Engine instance via `gcloud compute instances delete`.
- **`aws`** -- Terminates an AWS EC2 instance by looking up the instance ID from its Name tag.
- **`local`** -- No remote cleanup needed; prints a reminder to stop the local daemon.
- **`custom`** -- No remote cleanup; custom instances must be managed directly on the remote host.

#### Environment Variables

| Variable              | Required For | Description |
| --------------------- | ------------ | ----------- |
| `GCP_PROJECT`         | `gcp`        | GCP project ID. Falls back to the active `gcloud` project. |
| `GCP_DEFAULT_ZONE`    | `gcp`        | GCP zone of the compute instance. |
| `AWS_REGION`          | `aws`        | AWS region of the EC2 instance. |

#### Examples

```bash
# Retire a GCP instance (default)
vellum-cli retire my-assistant

# Retire a GCP instance explicitly
vellum-cli retire my-assistant --remote gcp

# Retire an AWS instance
AWS_REGION=us-east-1 vellum-cli retire my-assistant --remote aws
```
