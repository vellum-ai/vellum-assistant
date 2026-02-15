# IPC Contract

The IPC contract is the single source of truth for all message types exchanged between clients (Swift macOS app, CLI) and the daemon (Bun + TypeScript) over the Unix socket.

## Where it lives

The contract is defined in TypeScript at:

```
assistant/src/daemon/ipc-contract.ts
```

This file exports all message interfaces, grouped into:

- **Client -> Server** messages (`ClientMessage` union) -- requests sent by clients to the daemon
- **Server -> Client** messages (`ServerMessage` union) -- responses and events sent by the daemon to clients
- **Shared types** -- reusable types referenced by both directions (e.g. `UsageStats`, surface data types)

Each message interface has a `type` discriminator field (e.g. `type: 'user_message'`) used for routing on both sides.

## Generated artifacts

Swift Codable structs are auto-generated from the contract:

```
clients/shared/IPC/Generated/IPCContractGenerated.swift
```

This file is checked into the repo. It contains standalone DTOs (one `IPC`-prefixed struct per contract interface). The discriminated union enums (`ClientMessage` / `ServerMessage`) remain hand-written in `IPCMessages.swift` because they require custom `Decodable` init logic.

## Commands

| Command | Purpose |
|---------|---------|
| `bun run generate:ipc` | Regenerate the Swift file from the contract |
| `bun run check:ipc-generated` | Fail if the generated file would differ (used in CI) |
| `bun run ipc:inventory` | Check the contract inventory snapshot for drift (used in CI) |
| `bun run ipc:inventory:update` | Regenerate the inventory snapshot after adding/removing messages |

## Generation pipeline

The pipeline runs in `assistant/scripts/ipc/generate-swift.ts`:

1. **TypeScript -> JSON Schema**: `typescript-json-schema` extracts JSON Schema definitions from `ipc-contract.ts`
2. **JSON Schema -> Swift**: The generator walks each schema to produce Swift `Codable` structs, resolving `$ref` references, extracting inline objects as nested structs, and mapping TS `number` to Swift `Int` or `Double` based on property name heuristics
3. **Output**: The generated code is written to `clients/shared/IPC/Generated/IPCContractGenerated.swift`

Types listed in `SKIP_TYPES` within the generator are excluded from generation. These include the union types themselves (`ClientMessage`, `ServerMessage`), string-enum types that need hand-written Swift enums (`SessionErrorCode`, `TraceEventKind`), and types that reference them.

## How to add a new IPC message

### Step 1: Define the interface

Add a new interface to `assistant/src/daemon/ipc-contract.ts` with a `type` discriminator:

```typescript
export interface MyNewRequest {
  type: 'my_new_request';
  someField: string;
  optionalField?: number;
}
```

### Step 2: Add it to the union type

Add the interface to either `ClientMessage` (client -> server) or `ServerMessage` (server -> client):

```typescript
export type ClientMessage =
  | UserMessage
  | ...
  | MyNewRequest;  // <-- add here
```

### Step 3: Regenerate Swift models

```bash
cd assistant
bun run generate:ipc
```

This updates `clients/shared/IPC/Generated/IPCContractGenerated.swift` with a new `IPCMyNewRequest` struct.

### Step 4: Update the inventory snapshot

```bash
bun run ipc:inventory:update
```

This updates `assistant/src/daemon/ipc-contract-inventory.json` to include the new union member.

### Step 5: Wire up the Swift side

Add a case for the new message type in the hand-written `IPCMessages.swift` discriminated union enum, using the generated `IPCMyNewRequest` struct as the payload.

### Step 6: Implement the handler

Add a handler for the new message type in the daemon's message handler (`assistant/src/daemon/handlers.ts`).

### Step 7: Commit everything together

Stage the contract, generated Swift file, inventory snapshot, and any handler/Swift changes together. The pre-commit hook will verify consistency.

## How to modify an existing message

1. Edit the interface in `ipc-contract.ts`
2. Run `bun run generate:ipc` to regenerate the Swift struct
3. Run `bun run ipc:inventory:update` if you added/removed union members
4. Update any Swift code that decodes/encodes the changed fields
5. Update any daemon handlers that depend on the changed fields

Adding an optional field is backward-compatible. Removing a field or making an optional field required is a breaking change that requires coordinated client and daemon updates.

## CI and pre-commit enforcement

### CI (GitHub Actions)

The `ci-assistant.yml` workflow runs on every PR that touches `assistant/` or `clients/shared/IPC/Generated/`:

1. `bun run check:ipc-generated` -- fails if the generated Swift file doesn't match what the generator would produce
2. `bun run ipc:inventory` -- fails if the contract inventory snapshot has drifted

### Pre-commit hook

The `.githooks/pre-commit` hook runs automatically when any IPC-related file is staged:

- Checks the generated Swift file is up to date (`bun run check:ipc-generated`)
- Checks the inventory snapshot is up to date (`bun run ipc:inventory`)

If either check fails, the commit is blocked with instructions on how to fix it.

## Contract inventory

The inventory system tracks which interfaces are members of the `ClientMessage` and `ServerMessage` unions. It consists of:

- **Extractor** (`assistant/src/daemon/ipc-contract-inventory.ts`): Parses the TypeScript AST to extract sorted union member lists
- **Checker** (`assistant/scripts/ipc/check-contract-inventory.ts`): Compares the live contract against a checked-in snapshot
- **Snapshot** (`assistant/src/daemon/ipc-contract-inventory.json`): The checked-in baseline

This catches accidental additions or removals of union members that might otherwise go unnoticed.
