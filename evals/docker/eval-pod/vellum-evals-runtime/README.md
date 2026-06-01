# vellum-evals-runtime

A thin OCI runtime wrapper around `runc`, registered as a **named (non-default)
runtime** of the inner dockerd inside the privileged eval-pod. The eval
orchestrator selects it for the **single run/species container** it hatches, and
only that opted-in container gets its OCI `config.json` mutated so that:

1. The container's process environment has our three TLS-CA env vars set:
   - `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/recording-ca.pem`
   - `REQUESTS_CA_BUNDLE=/etc/ssl/certs/recording-ca.pem`
   - `SSL_CERT_FILE=/etc/ssl/certs/recording-ca.pem`
2. The container has a read-only bind-mount of the host CA file at
   `/etc/ssl/certs/recording-ca.pem`.
3. The container does **not** create its own network namespace — instead it
   inherits the eval-pod's netns, where iptables NAT redirects `:443 → :8443`
   into mitmproxy.

Together these three changes mean the run/species container (Vellum, Hermes,
OpenClaw, …) is born trusting our recording CA and routes outbound TLS through
mitmproxy, **without any code changes on the species side**.

The wrapper is opt-in per container: it only applies these mutations when the
spec carries the `ai.vellum.evals.mitm` OCI annotation. Every other container
the inner dockerd creates — recording sidecars, sub-containers the agent spins
up, anything launched with `--network=none` or `--network container:<target>` —
is left byte-for-byte untouched and keeps its own network namespace and trust
store. See [Scope](#scope-why-not-default-runtime).

## Lifecycle

```
containerd-shim
  └── vellum-evals-runtime create --bundle /var/lib/docker/.../bundle <cid>
        │
        │  1. detect `create` subcommand
        │  2. find --bundle dir
        │  3. read <bundle>/config.json
        │  4. opted in? (ai.vellum.evals.mitm annotation) — if not, pass through
        │  5. mutate (env + mount + drop netns)
        │  6. write back
        │
        └── exec /usr/bin/runc create --bundle /var/lib/docker/.../bundle <cid>
              │ (real runc reads the now-mutated config and creates the container)
              ▼
            container running
```

The wrapper exits the moment it `exec`s real runc. It does **not** run for the
lifetime of the container. All non-`create` subcommands (`start`, `state`,
`kill`, `delete`, ...) — and every `create` for a container that is **not**
opted in — pass through to real runc unchanged.

## How dockerd is told to use it

The eval-pod's inner dockerd registers the wrapper as a **named** runtime but
leaves the stock `runc` as the default, so untouched containers run normally:

```json
{
  "runtimes": {
    "vellum-evals-runtime": {
      "path": "/usr/local/bin/vellum-evals-runtime"
    }
  }
}
```

The orchestrator then selects the runtime **and** sets the opt-in annotation on
the run/species container only:

```sh
docker run \
  --runtime vellum-evals-runtime \
  --annotation ai.vellum.evals.mitm=1 \
  <species-image> ...
```

`--annotation` passes the key through to the OCI spec's `.annotations`
([docker run reference](https://docs.docker.com/reference/cli/docker/container/run/));
the wrapper reads it to decide whether to mutate. `--runtime` is the primary
scoping; the annotation is the in-binary fail-safe.

(The eval-pod Dockerfile + start.sh that set this up ship in a follow-up PR.)

## Scope (why not default-runtime)

The wrapper is **not** the dockerd `default-runtime`, and the network-namespace
drop is **not** applied to every container. Doing so was a container-isolation
regression: the inner dockerd creates more than just the species container
(recording sidecars, sub-containers the agent itself launches, etc.). Forcing
_all_ of them to share the eval-pod netns means an untrusted eval/species
container could:

- reach pod-local `localhost` services it should never see,
- contend for or listen on the same ports as sidecars, and
- with `CAP_NET_RAW`, observe or interfere with sibling/sidecar traffic.

It also overrode explicit isolation requests (`--network=none`,
`--network container:<target>`, custom bridge networks) silently.

Scoping the runtime to a single opted-in container confines the MITM plumbing to
exactly the container whose egress we need to record, and lets every other
container keep the network isolation it asked for. The orchestrator opts in via
`--runtime` + `--annotation` — no species-image changes required.

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

Tests exercise (a) the pure spec-mutation function with table-driven inputs,
(b) the opt-in gate that scopes the rewrite to annotated containers, and
(c) the arg-parser + on-disk rewrite path against a tempdir-hosted synthetic
bundle. No runc, no docker, no network — all hermetic.
