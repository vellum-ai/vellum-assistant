# vellum-evals-runtime

A thin OCI runtime wrapper around `runc`, configured as the **default-runtime** of
the inner dockerd inside the privileged eval-pod. Its sole job is to mutate the
OCI `config.json` of every container the inner dockerd creates so that:

1. The container's process environment has our three TLS-CA env vars set:
   - `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/recording-ca.pem`
   - `REQUESTS_CA_BUNDLE=/etc/ssl/certs/recording-ca.pem`
   - `SSL_CERT_FILE=/etc/ssl/certs/recording-ca.pem`
2. The container has a read-only bind-mount of the host CA file at
   `/etc/ssl/certs/recording-ca.pem`.
3. The container does **not** create its own network namespace — instead it
   inherits the eval-pod's netns, where iptables NAT redirects `:443 → :8443`
   into mitmproxy.

Together these three changes mean every assistant species container (Vellum,
Hermes, OpenClaw, …) is born trusting our recording CA and routes outbound
TLS through mitmproxy, **without any code changes on the species side**.

## Lifecycle

```
containerd-shim
  └── vellum-evals-runtime create --bundle /var/lib/docker/.../bundle <cid>
        │
        │  1. detect `create` subcommand
        │  2. find --bundle dir
        │  3. read <bundle>/config.json
        │  4. mutate (env + mount + drop netns)
        │  5. write back
        │
        └── exec /usr/bin/runc create --bundle /var/lib/docker/.../bundle <cid>
              │ (real runc reads the now-mutated config and creates the container)
              ▼
            container running
```

The wrapper exits the moment it `exec`s real runc. It does **not** run for the
lifetime of the container. All non-`create` subcommands (`start`, `state`,
`kill`, `delete`, ...) pass through to real runc unchanged.

## How dockerd is told to use it

The eval-pod's inner dockerd is started with this `daemon.json`:

```json
{
  "default-runtime": "vellum-evals-runtime",
  "runtimes": {
    "vellum-evals-runtime": {
      "path": "/usr/local/bin/vellum-evals-runtime"
    }
  }
}
```

(The eval-pod Dockerfile + start.sh that set this up ship in a follow-up PR.)

## Configuration

Two environment variables, both with sensible defaults:

| Env var                             | Default                          | Purpose                                                                                                                                   |
| ----------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `VELLUM_EVALS_RUNTIME_REAL_RUNC`    | `/usr/bin/runc`                  | The real OCI runtime we `exec` after mutation. Override only for tests.                                                                   |
| `VELLUM_EVALS_RUNTIME_CA_HOST_PATH` | `/etc/eval-pod/recording-ca.pem` | Absolute path on the eval-pod host to the recording CA PEM. The eval-pod startup script writes this file before any container is created. |

## Why a custom OCI runtime instead of …

| Alternative                                 | Why it doesn't work                                                                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Prestart hook**                           | OCI prestart hooks fire _after_ runc has already realized `spec.process.env`. Hooks can't inject env vars; the spec is locked.                           |
| **`docker run -v` + `-e` on every species** | Requires the species adapter to know about MITM. The whole point is zero CLI/assistant-side changes.                                                     |
| **Monkey-patching `fetch`/`requests.post`** | Every species ships its own HTTP libraries (Node, Python, Go). Agents trivially route around any user-space patch (raw http, exec'd curl, tool servers). |
| **Per-image Dockerfile patch**              | Requires modifying every species image. Doesn't compose.                                                                                                 |

The OCI runtime layer is the **first point in the container creation pipeline
where the spec is mutable**, and the **last point that's species-agnostic**.
One wrapper covers every current and future species without touching their
code.

## Boundaries

The runtime knows about **containers**, not **runs** and not **packets**.

- TS evals runner (orchestration, lives outside the pod) → knows about runs.
- This binary (container plumbing, lives inside the pod) → knows about containers.
- mitmproxy + addon (payload inspection, lives in the pod netns) → knows about packets.

If you find yourself reaching for run-level state (which test? which profile?)
or packet-level state (which HTTP request? what's in the body?) inside this
binary, you're in the wrong layer.

## Build

```sh
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o vellum-evals-runtime ./
```

Produces a statically linked binary with no runtime dependencies — drops
straight into the eval-pod image with no Go toolchain or libc needed.

## Test

```sh
go test ./...
```

Tests exercise (a) the pure spec-mutation function with table-driven inputs
and (b) the arg-parser + on-disk rewrite path against a tempdir-hosted
synthetic bundle. No runc, no docker, no network — all hermetic.
