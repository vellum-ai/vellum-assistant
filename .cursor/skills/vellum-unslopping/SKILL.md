---
name: vellum-unslopping
description: Remove code slop (pass-through wrappers, alias locals, identity transforms, leftover names, narrating comments) without changing behavior. Use when running an Unslopping pass, cleaning agent-generated code, or reviewing a diff for needless indirection.
---

# Unslopping

Unslopping deletes indirection that does not earn its keep. The code after the pass should do the same thing, with fewer names, fewer hops, and fewer comments that restate the next line.

Unslopping is not restyling, not renaming for taste, and not collapsing a real boundary. If removing a name would change behavior, leak an internal, break a public export, or hide a test seam, keep it.

## How to run a pass

1. Search for the patterns below. Do not rewrite surrounding architecture while you are here.
2. Keep the name callers need. Delete the other name.
3. Delete rather than comment out. If a comment only makes sense as a record of the deletion, drop it. History lives in the PR.
4. Stay behavior-preserving. Run the focused tests for files you touch.
5. Skip generated files, vendored code, and snapshot fixtures unless the slop is in the generator input.

## What to keep

Keep a wrapper, alias, or extra local when it does at least one of these:

- Maps, validates, logs, or translates at the boundary (HTTP, IPC, package, skill).
- Is a public or CLI-facing name that other packages or shipped clients import.
- Exists so tests can stub one side without importing the other.
- Gives a domain name to a value that is otherwise a magic literal or a messy expression used more than once.

Braces on `if` / `else` / `for` / `while` stay. One-line bodies are not slop in this repo.

---

## Rules

### 1. Pass-through wrappers

A function whose body only calls one other function, with the same arguments and the same return, is slop. After two strategies collapse into one, the leftover dispatcher is the same bug.

Motivating case: after local and managed CES discovery share one socket path, `discoverCes()` became `return discoverManagedCes()`. That hop should go. Keep the better name (usually the one callers already use) and inline or retarget the other.

Slop:

```ts
export function discoverCes(): DiscoveryResult {
  return discoverManagedCes();
}
```

Unslopped: callers use one function. If `discoverCes` is the name the rest of the tree already imports, move the body there and delete `discoverManagedCes`.

```ts
export function discoverCes(): DiscoveryResult {
  const socketPath = getCesSocketPath();
  if (!isNamedPipePath(socketPath) && !existsSync(socketPath)) {
    return { mode: "unavailable", reason: `CES bootstrap socket not found at ${socketPath}` };
  }
  return { mode: "managed", socketPath };
}
```

Keep it when the wrapper is the package's public surface and the callee is private on purpose.

### 2. Alias locals

A variable that only rebinds another value, then gets passed along, is slop. Use the original name at the call site.

Slop:

```ts
const b = a;
callMethod(b);
```

Unslopped:

```ts
callMethod(a);
```

Same for `const socketPath = result.socketPath; connect(socketPath)` and for `const { socketPath } = result` when the alias is used once and the original name is already clear.

Keep it when the alias is a domain name that the original expression does not carry (`const guardianToken = process.env["TOKEN"]`), or when it is assigned so a later mutation or narrowing can happen.

### 3. Return-only locals

A local whose only job is to be returned on the next line is an alias with extra ceremony.

Slop:

```ts
function loadConfig(): Config {
  const config = readConfigFile();
  return config;
}
```

Unslopped:

```ts
function loadConfig(): Config {
  return readConfigFile();
}
```

Keep it when the next lines log, mutate, or narrow the value.

### 4. Boolean theater

Do not wrap a boolean in another boolean. Do not turn a condition into `true` / `false` by hand.

Slop:

```ts
const isReady = ready === true;
if (isReady) {
  start();
}
```

Unslopped:

```ts
if (ready) {
  start();
}
```

`isEnabled ? true : false`, `if (isEnabled) { return true; } return false;`, and `!!alreadyBoolean` are the same slop. `Boolean(x)` is fine when `x` is not already a boolean and you need a real `boolean`.

### 5. Identity transforms

A copy, map, spread, or template that yields the same value is slop.

Slop:

```ts
const name = `${userName}`;
const copy = { ...options };
const ids = userIds.map((id) => id);
return Promise.resolve(value);
```

Unslopped:

```ts
connect(userName, options, userIds);
return value;
```

Keep a copy when the next lines mutate it, when you must freeze a snapshot against later writes, or when you spread to add or override keys.

### 6. Narrating comments and banner dividers

Comments describe what the code is, not what the next line does, and not how a previous PR got here. Decorative `// ----` section banners are slop. So is a JSDoc that restates the function name.

Slop:

```ts
// ---------------------------------------------------------------------------
// Managed discovery
// ---------------------------------------------------------------------------

/**
 * Discover CES.
 */
export function discoverCes(): DiscoveryResult {
  // Get the socket path
  const socketPath = getCesSocketPath();
  // Check that it exists
  if (!existsSync(socketPath)) {
    return { mode: "unavailable", reason: `CES bootstrap socket not found at ${socketPath}` };
  }
  return { mode: "managed", socketPath };
}
```

Unslopped:

```ts
export function discoverCes(): DiscoveryResult {
  const socketPath = getCesSocketPath();
  if (!existsSync(socketPath)) {
    return { mode: "unavailable", reason: `CES bootstrap socket not found at ${socketPath}` };
  }
  return { mode: "managed", socketPath };
}
```

Keep a comment that states an invariant a reader cannot see from the code (fail-closed, "do not open a connection here, CES accepts one slot", why a timeout is 3s). Present tense only. No "no longer", "previously", "now uses".

### 7. Leftover names after a unification

When two paths become one, leftover vocabulary is slop: a `SiblingDiscoverySuccess` that is identical to `ManagedDiscoverySuccess`, a `mode: "sibling"` that nothing branches on, an env var name in a comment for a flag that is gone.

Slop:

```ts
export type DiscoveryResult =
  | ManagedDiscoverySuccess
  | SiblingDiscoverySuccess
  | DiscoveryFailure;
```

Unslopped:

```ts
export type DiscoveryResult = ManagedDiscoverySuccess | DiscoveryFailure;
```

If every environment uses the same socket path, stop calling the only remaining function `discoverManagedCes` unless "managed" is still a real distinction. Do not rename a `mode` string that is already on the wire.

Keep a distinct type or mode when callers still switch on it.

### 8. No-op try/catch

A `try` that only rethrows, or a `catch` that logs nothing and does not recover, is slop. So is `catch (error) { throw error; }`.

Slop:

```ts
try {
  return await readSecret(name);
} catch (error) {
  throw error;
}
```

Unslopped:

```ts
return await readSecret(name);
```

Keep try/catch when it translates the error (`RouteError`), records it (`captureError`), or degrades on purpose (daemon startup continues when a subsystem fails).

### 9. Duplicate callee guards

Do not repeat a check the function you are about to call already performs. The second check is a second source of truth and will drift.

Slop:

```ts
function connect(socketPath: string): void {
  if (!existsSync(socketPath)) {
    throw new Error(`missing socket: ${socketPath}`);
  }
  openSocket(socketPath);
}

function start(): void {
  const socketPath = getCesSocketPath();
  if (!existsSync(socketPath)) {
    throw new Error(`missing socket: ${socketPath}`);
  }
  connect(socketPath);
}
```

Unslopped:

```ts
function start(): void {
  connect(getCesSocketPath());
}
```

Keep a caller-side guard when it avoids a costly call, when the error must be a different shape at that layer, or when the callee is a third-party that does not fail closed.

### 10. Single-use speculative helpers

A helper, type alias, or options bag used once, that does not hide mess and does not form a boundary, is slop. Extract on the second occurrence, not the first.

Slop:

```ts
type SocketPath = string;

function joinBootstrapSocket(dir: string): SocketPath {
  return join(dir, "ces.sock");
}

export function discoverCes(): DiscoveryResult {
  const socketPath = joinBootstrapSocket(
    process.env["CES_BOOTSTRAP_SOCKET_DIR"] ?? "/run/ces-bootstrap",
  );
  return lookup(socketPath);
}
```

Unslopped:

```ts
export function discoverCes(): DiscoveryResult {
  const dir =
    process.env["CES_BOOTSTRAP_SOCKET_DIR"] ?? "/run/ces-bootstrap";
  return lookup(join(dir, "ces.sock"));
}
```

If CLI, CES, and assistant must agree on the path, the helper is the contract and stays (`resolveIpcEndpoint`, not a private `join` alias). Delete a helper when it is a private alias for a stdlib call used once.

---

## Out of scope

These look adjacent and are not Unslopping:

- Collapsing two similar but branching functions into one "clever" function.
- Rewording identifiers that already match the current design.
- Removing braces, turning `if` into a ternary, or shrinking a file for line count.
- Deleting migrations, compat shims that shipped clients still hit, or generated OpenAPI clients.
- Moving code across `assistant/` / `gateway/` / `skills/` / `meta/` to make a wrapper go away.

If a candidate fails the "same behavior, fewer hops" test, leave it and note it in the PR instead of forcing it.
