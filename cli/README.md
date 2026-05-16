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

| Option              | Description                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `-d`                | Detached mode. Start the instance in the background without watching startup progress.                             |
| `--name <name>`     | Use a specific instance name instead of an auto-generated one.                                                     |
| `--remote <target>` | Where to provision the instance. One of: `local`, `docker`, `vellum`, `gcp`, `aws`, `custom`. Defaults to `local`. |

#### Remote Targets

- **`local`** -- Starts the local assistant and local gateway. Gateway source resolution order is: repo source tree, then installed `@vellumai/vellum-gateway` package.
- **`docker`** -- Starts the assistant, gateway, and credential service in Docker containers.
- **`vellum`** -- Hatches an assistant on the Vellum platform.
- **`gcp`** and **`aws`** -- Recognized but not supported as provisioning targets yet. The CLI exits before creating cloud resources. To self-host on AWS/GCP, SSH into the VM and run `vellum hatch` or `vellum hatch --remote docker` there.
- **`custom`** -- Recognized but not yet implemented.

#### Environment Variables

| Variable            | Required For | Description                                                                |
| ------------------- | ------------ | -------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | Optional     | Used during setup when no Anthropic API key is already stored or prompted. |

#### Examples

```bash
# Hatch a local assistant (default)
vellum hatch

# Hatch a Docker assistant
vellum hatch --remote docker

# Hatch with a specific instance name
vellum hatch --name my-assistant --remote docker
```

AWS and GCP hatch targets are recognized so users receive an explicit unsupported-target error instead of an unknown-option error. They currently exit without creating cloud resources; self-hosting on an AWS/GCP VM still works by running `vellum hatch` from inside that machine.

### `terminal`

Open an interactive shell into a managed assistant container. Useful for debugging, inspecting state, or working alongside the assistant in a shared `tmux` session.

```bash
vellum terminal [name] [options]
vellum terminal attach <session> [name] [options]
vellum terminal list [name] [options]
```

Only available for managed assistants (those running in a Vellum Cloud container). Local assistants don't have a container to terminal into.

#### Subcommands

| Subcommand         | Description                                                        |
| ------------------ | ------------------------------------------------------------------ |
| _(none)_           | Open an interactive shell session inside the container.            |
| `attach <session>` | Attach to an existing `tmux` session by name inside the container. |
| `list`             | List the `tmux` sessions currently running inside the container.   |

#### Options

| Option               | Description                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| `[name]`             | Positional. Name of the assistant to target. Defaults to the active assistant set via `vellum use`. |
| `--assistant <name>` | Explicit form of the assistant name. Equivalent to the positional argument.                         |

If no assistant is named and no active assistant is set, the CLI uses the only managed assistant in the lockfile -- or errors out if there's more than one. Use `vellum ps` to see your assistants and `vellum use <name>` to set the active one.

#### Examples

```bash
# Open a shell in the active managed assistant
vellum terminal

# Target a specific assistant by name
vellum terminal my-assistant
vellum terminal --assistant my-assistant

# List running tmux sessions inside the container
vellum terminal list

# Attach to a named tmux session
vellum terminal attach my-session
vellum terminal attach my-session my-assistant
```

This pairs well with the [`terminal-sessions` skill](https://github.com/vellum-ai/vellum-assistant/tree/main/skills/terminal-sessions), which lets the assistant create and manage its own `tmux` sessions. You can `vellum terminal attach` into one of those sessions to watch the assistant work in real time -- for example, pairing on a long-running Claude Code run.

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
