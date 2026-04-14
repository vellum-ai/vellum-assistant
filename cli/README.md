# @vellumai/cli

CLI tools for provisioning and managing Vellum assistant instances.

## Installation

This package is used internally by the [`vel`](https://github.com/vellum-ai/vellum-assistant-platform/tree/main/vel) CLI. You typically don't need to install it directly.

To run it standalone with [Bun](https://bun.sh):

```bash
bun run ./src/index.ts <command> [options]
```

## Commands

### Lifecycle: `ps`, `sleep`, `wake`

Day-to-day process management for the assistant and gateway.

| Command        | Description                                                                            |
| -------------- | -------------------------------------------------------------------------------------- |
| `vellum ps`    | List assistants and per-assistant process status (assistant, gateway PIDs and health). |
| `vellum sleep` | Stop assistant and gateway processes. Directory-agnostic — works from anywhere.        |
| `vellum wake`  | Start the assistant and gateway from the current checkout.                             |

```bash
# Start everything
vellum wake

# Check what's running
vellum ps

# Stop everything
vellum sleep
```

> **Note:** `vellum wake` requires a hatched assistant. Run `vellum hatch` first, or launch the macOS app which handles hatching automatically.

### `hatch`

Provision a new assistant instance and bootstrap the Vellum runtime on it.

```bash
vellum hatch [species] [options]
```

#### Species

| Species    | Description                                       |
| ---------- | ------------------------------------------------- |
| `vellum`   | Default. Provisions the Vellum assistant runtime. |
| `openclaw` | Provisions the OpenClaw runtime with gateway.     |

#### Options

| Option              | Description                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `-d`                | Detached mode. Start the instance in the background without watching startup progress.         |
| `--name <name>`     | Use a specific instance name instead of an auto-generated one.                                 |
| `--remote <target>` | Where to provision the instance. One of: `local`, `gcp`, `aws`, `custom`. Defaults to `local`. |

#### Remote Targets

- **`local`** -- Starts the local assistant and local gateway. Gateway source resolution order is: repo source tree, then installed `@vellumai/vellum-gateway` package.
- **`gcp`** -- Creates a GCP Compute Engine VM (`e2-standard-4`: 4 vCPUs, 16 GB) with a startup script that bootstraps the assistant. Requires `gcloud` authentication and `GCP_PROJECT` / `GCP_DEFAULT_ZONE` environment variables.
- **`aws`** -- Provisions an AWS instance.
- **`custom`** -- Provisions on an arbitrary SSH host. Set `VELLUM_CUSTOM_HOST` (e.g. `user@hostname`) to specify the target.

#### Environment Variables

| Variable             | Required For | Description                                                |
| -------------------- | ------------ | ---------------------------------------------------------- |
| `ANTHROPIC_API_KEY`  | All          | Anthropic API key passed to the assistant runtime.         |
| `GCP_PROJECT`        | `gcp`        | GCP project ID. Falls back to the active `gcloud` project. |
| `GCP_DEFAULT_ZONE`   | `gcp`        | GCP zone for the compute instance.                         |
| `VELLUM_CUSTOM_HOST` | `custom`     | SSH host in `user@hostname` format.                        |

#### Examples

```bash
# Hatch a local assistant (default)
vellum hatch

# Hatch a vellum assistant on GCP
vellum hatch vellum --remote gcp

# Hatch an openclaw assistant on GCP in detached mode
vellum hatch openclaw --remote gcp -d

# Hatch with a specific instance name
vellum hatch --name my-assistant --remote gcp

# Hatch on a custom SSH host
VELLUM_CUSTOM_HOST=user@10.0.0.1 vellum hatch --remote custom
```

When hatching on GCP in interactive mode (without `-d`), the CLI displays an animated progress TUI that polls the instance's startup script output in real time. Press `Ctrl+C` to detach -- the instance will continue running in the background.

### `retire`

Delete a provisioned assistant instance. The cloud provider and connection details are automatically resolved from the saved assistant config (written during `hatch`).

```bash
vellum retire <name>
```

The CLI looks up the instance by name in the production lockfile (`~/.vellum.lock.json`) or the env-scoped lockfile under `$XDG_CONFIG_HOME/vellum-<env>/lockfile.json` for non-production environments, then determines how to retire it based on the saved `cloud` field:

- **`gcp`** -- Deletes the GCP Compute Engine instance via `gcloud compute instances delete`.
- **`aws`** -- Terminates the AWS EC2 instance by looking up the instance ID from its Name tag.
- **`local`** -- Stops the local assistant (`vellum sleep`) and removes the assistant's instance directory (`resources.instanceDir` in the lockfile; typically `~/.local/share/vellum/assistants/<name>/` for new hatches, or `~/.vellum/` for legacy entries).
- **`custom`** -- SSHs to the remote host to stop the assistant/gateway and remove the remote `~/.vellum` directory.

#### Examples

```bash
# Retire an instance (cloud type resolved from config)
vellum retire my-assistant
```
