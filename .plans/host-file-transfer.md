# host_file_transfer Tool

## Overview
Add a new `host_file_transfer` tool that copies files between the assistant's workspace (sandbox) and the user's host machine. In local mode, this is a direct `fs.copyFile`; in managed/cloud mode, it uses a streaming binary transfer protocol over HTTP — pull-based for `to_host` (client GETs file from assistant) and push-based for `to_sandbox` (client PUTs file to assistant). SHA-256 integrity verification, single-use transfer IDs, and size-adaptive timeouts ensure safe, reliable delivery of arbitrary binary files without passing content through the LLM's context window.

## PR 1: TypeScript message types and pending interaction registration
### Depends on
None

### Branch
host-file-xfer/pr-1-message-types

### Title
feat(host-transfer): add SSE message types and pending interaction kind

### Files
- `assistant/src/daemon/message-types/host-transfer.ts`
- `assistant/src/daemon/message-protocol.ts`
- `assistant/src/runtime/pending-interactions.ts`
- `assistant/src/runtime/routes/conversation-routes.ts`
- `assistant/src/daemon/server.ts`

### Implementation steps
1. Create `assistant/src/daemon/message-types/host-transfer.ts` with these interfaces:
   - `HostTransferToHostRequest`: `{ type: "host_transfer_request", requestId: string, conversationId: string, direction: "to_host", transferId: string, destPath: string, sizeBytes: number, sha256: string, overwrite: boolean }`
   - `HostTransferToSandboxRequest`: `{ type: "host_transfer_request", requestId: string, conversationId: string, direction: "to_sandbox", transferId: string, sourcePath: string }`
   - `HostTransferRequest = HostTransferToHostRequest | HostTransferToSandboxRequest`
   - `HostTransferCancelRequest`: `{ type: "host_transfer_cancel", requestId: string }`
   - Export `_HostTransferServerMessages = HostTransferRequest | HostTransferCancelRequest`
2. In `assistant/src/daemon/message-protocol.ts`: import `_HostTransferServerMessages` from the new file and add it to the `ServerMessage` union type (alongside the existing `_HostFileServerMessages`, `_HostBashServerMessages`, etc.).
3. In `assistant/src/runtime/pending-interactions.ts`: add `"host_transfer"` to the `kind` union type in the `PendingInteraction` interface (line ~47). Add `"host_transfer"` to the exclusion list in `removeByConversation()` (line ~118) so in-flight transfers survive new user messages.
4. In `assistant/src/runtime/routes/conversation-routes.ts`: in the `registerHostProxyPendingInteraction()` function (line ~1191), add a new `if (msg.type === "host_transfer_request")` branch that registers with `kind: "host_transfer"`.
5. In `assistant/src/daemon/server.ts`: in the `makePendingInteractionRegistrar()` function, add an `else if (msg.type === "host_transfer_request")` branch that registers with `kind: "host_transfer"`.
6. Add unit tests for the new message type parsing and pending interaction registration in a colocated test file.

### Acceptance criteria
- `HostTransferRequest` and `HostTransferCancelRequest` types compile and are part of the `ServerMessage` union
- `"host_transfer"` is a valid `PendingInteraction` kind
- SSE messages with `type: "host_transfer_request"` are automatically registered as pending interactions in both daemon server and HTTP conversation routes
- In-flight transfer interactions are not cleaned up when a new user message arrives

## PR 2: Permission defaults and risk classification
### Depends on
None

### Branch
host-file-xfer/pr-2-permissions

### Title
feat(host-transfer): register host_file_transfer permissions and risk classification

### Files
- `assistant/src/permissions/defaults.ts`
- `assistant/src/permissions/file-risk-classifier.ts`

### Implementation steps
1. In `assistant/src/permissions/defaults.ts`: add `"host_file_transfer"` to the `HOST_FILE_TOOLS` array (line ~36). This automatically generates a default `ask` rule with pattern `host_file_transfer:/**` at priority 50.
2. In `assistant/src/permissions/file-risk-classifier.ts`:
   - Add `"host_file_transfer"` to the `FileClassifierInput.toolName` union type (line ~38).
   - In the `classify()` method, add a case for `host_file_transfer` that classifies based on the destination path. For `to_host` direction, apply existing host path sensitivity heuristics to `dest_path` (escalate to `HIGH` for system directories, skill source, hooks dir). For `to_sandbox` direction, use the default `Medium` risk (sandbox policy applies).
   - The classifier receives `filePath` which should be the destination path — the tool executor will pass `dest_path` as the classified path.
3. Add unit tests verifying:
   - `host_file_transfer` has a default `ask` rule generated
   - Risk escalation to HIGH for sensitive host paths (e.g., `/usr/local/bin/`, skill source dirs)
   - Default Medium risk for normal paths

### Acceptance criteria
- `host_file_transfer` appears in the default permission rules with `ask` decision
- FileRiskClassifier correctly classifies `host_file_transfer` with Medium default, High for sensitive destinations
- Existing host file tool permissions are unchanged

## PR 3: Swift message types and SSE routing
### Depends on
None

### Branch
host-file-xfer/pr-3-swift-message-types

### Title
feat(host-transfer): add Swift message types and SSE routing for host file transfer

### Files
- `clients/shared/Network/MessageTypes.swift`
- `clients/macos/vellum-assistant/App/AppDelegate+ConnectionSetup.swift`

### Implementation steps
1. In `clients/shared/Network/MessageTypes.swift`:
   - Add `HostTransferRequest` struct (Decodable, Sendable) with fields: `type: String`, `requestId: String`, `conversationId: String`, `direction: String` ("to_host" | "to_sandbox"), `transferId: String`, `destPath: String?` (for to_host), `sourcePath: String?` (for to_sandbox), `sizeBytes: Int?`, `sha256: String?`, `overwrite: Bool?`.
   - Add `HostTransferCancelRequest` struct (Decodable, Sendable) with: `type: String`, `requestId: String`.
   - Add `HostTransferResultPayload` struct (Codable, Sendable) with: `requestId: String`, `isError: Bool`, `bytesWritten: Int?`, `errorMessage: String?`.
   - Add `.hostTransferRequest(HostTransferRequest)` and `.hostTransferCancel(HostTransferCancelRequest)` cases to the `ServerMessage` enum (near line ~2618).
   - Add decoder cases in `ServerMessage.init(from:)` for `"host_transfer_request"` → `.hostTransferRequest(...)` and `"host_transfer_cancel"` → `.hostTransferCancel(...)` (near line ~3096).
2. In `clients/macos/vellum-assistant/App/AppDelegate+ConnectionSetup.swift`:
   - In the SSE message switch statement (near line ~374), add:
     ```swift
     case .hostTransferRequest(let msg):
         HostToolExecutor.executeHostTransferRequest(msg)
     case .hostTransferCancel(let msg):
         HostToolExecutor.cancelHostTransferRequest(msg.requestId)
     ```
   - These will initially produce compiler errors until PR 6 adds the executor methods — add stub `fatalError("not implemented")` methods to `HostToolExecutor` to satisfy the compiler, with a `// TODO: implement in host-file-xfer/pr-6` comment.

### Acceptance criteria
- `HostTransferRequest` and `HostTransferCancelRequest` decode correctly from JSON
- `ServerMessage` enum handles `"host_transfer_request"` and `"host_transfer_cancel"` type strings
- SSE messages are routed to the executor stubs in AppDelegate
- Existing message types are unaffected

## PR 4: Transfer lifecycle proxy (HostTransferProxy)
### Depends on
PR 1

### Branch
host-file-xfer/pr-4-transfer-proxy

### Title
feat(host-transfer): add HostTransferProxy lifecycle manager with streaming state

### Files
- `assistant/src/daemon/host-transfer-proxy.ts`
- `assistant/src/tools/types.ts`
- `assistant/src/daemon/conversation-tool-setup.ts`
- `assistant/src/daemon/conversation.ts`

### Implementation steps
1. Create `assistant/src/daemon/host-transfer-proxy.ts` implementing the transfer lifecycle manager:
   - `PendingTransfer` type: `{ resolve, reject, timer, transferId, direction, filePath, sizeBytes?, sha256?, fileBuffer?: Buffer, detachAbort? }`
   - Constructor: `(sendToClient: (msg: ServerMessage) => void, onInternalResolve?: (requestId: string) => void)`
   - `pending: Map<string, PendingTransfer>` — keyed by requestId
   - `transfers: Map<string, PendingTransfer>` — keyed by transferId (for content endpoint lookups)
   - `requestToHost(input: { sourcePath, destPath, overwrite, conversationId }, signal?: AbortSignal): Promise<ToolExecutionResult>`:
     1. Read source file, compute size and SHA-256 hash (using `node:crypto`)
     2. Generate UUID transferId and requestId
     3. Store the file buffer (or a read stream reference) in the pending transfer keyed by transferId
     4. Send `host_transfer_request` message with `direction: "to_host"`, transferId, destPath, sizeBytes, sha256, overwrite
     5. Set timeout: `max(120_000, (sizeBytes / (1024 * 1024)) * 1000 + 30_000)` ms
     6. Return Promise that resolves when client POSTs result
   - `requestToSandbox(input: { sourcePath, destPath, conversationId }, signal?: AbortSignal): Promise<ToolExecutionResult>`:
     1. Generate UUID transferId and requestId
     2. Store the pending transfer with destPath keyed by transferId
     3. Send `host_transfer_request` message with `direction: "to_sandbox"`, transferId, sourcePath
     4. Set timeout: 120_000ms base (file size unknown until client pushes)
     5. Return Promise that resolves when file is received and verified
   - `resolveTransferResult(requestId: string, result: { isError: boolean, bytesWritten?: number, errorMessage?: string }): void` — for to_host results from the client
   - `getTransferContent(transferId: string): { stream: ReadableStream, sizeBytes: number, sha256: string } | null` — for the GET content endpoint; returns null and deletes entry if transferId is consumed or unknown
   - `receiveTransferContent(transferId: string, data: Buffer, sha256Header: string): Promise<{ accepted: boolean, error?: string }>` — for the PUT content endpoint; writes to sandbox dest_path, verifies SHA-256, resolves the pending request
   - `cancel(requestId: string)`: clear timeout, reject pending, send cancel message
   - `dispose()`: cancel all pending, cleanup
   - `updateSender(sendToClient, clientConnected)`: update transport (mirrors HostFileProxy pattern)
   - `isAvailable(): boolean`: returns `clientConnected`
   - `hasPendingTransfer(transferId: string): boolean`
2. In `assistant/src/tools/types.ts`: add `hostTransferProxy?: HostTransferProxy` to the `ToolContext` interface (near line ~241, after `hostFileProxy`). Import the type.
3. In `assistant/src/daemon/conversation-tool-setup.ts`: add `hostTransferProxy?: HostTransferProxy` to the `ToolSetupContext` interface (near line ~119). Wire it into the ToolContext during executor setup.
4. In `assistant/src/daemon/conversation.ts`:
   - Add `private hostTransferProxy?: HostTransferProxy` field
   - Add `setHostTransferProxy(proxy: HostTransferProxy | undefined)` method (mirroring `setHostFileProxy`)
   - Add `resolveHostTransfer(requestId: string, result: { isError: boolean, bytesWritten?: number, errorMessage?: string })` method that delegates to `this.hostTransferProxy?.resolveTransferResult()`
   - Add `getHostTransferProxy(): HostTransferProxy | undefined` getter for route handlers
   - In the conversation's proxy setup flow (where `setHostFileProxy` is called), also instantiate and set the `HostTransferProxy` with the same `sendToClient` callback
   - In `dispose()`, dispose the transfer proxy
5. Add comprehensive unit tests for HostTransferProxy:
   - Test timeout behavior with the size-adaptive formula
   - Test single-use transferId consumption (second getTransferContent returns null)
   - Test abort signal handling
   - Test cleanup on dispose

### Acceptance criteria
- `HostTransferProxy` correctly manages transfer lifecycle with pending maps keyed by both requestId and transferId
- Timeouts are size-adaptive using the formula `max(120s, sizeBytes/1MB + 30s)`
- TransferIds are single-use — consumed on first content endpoint access
- Proxy is wired into ToolContext and conversation lifecycle
- SHA-256 verification is performed on received content (to_sandbox direction)
- Abort signals properly cancel in-flight transfers

## PR 5: HTTP routes for transfer content streaming and result
### Depends on
PR 4

### Branch
host-file-xfer/pr-5-transfer-routes

### Title
feat(host-transfer): add HTTP endpoints for binary content streaming and result submission

### Files
- `assistant/src/runtime/routes/host-transfer-routes.ts`
- `assistant/src/runtime/http-server.ts`

### Implementation steps
1. Create `assistant/src/runtime/routes/host-transfer-routes.ts` with three route handlers:
   - **`handleTransferContentGet(transferId: string, req: Request, authContext: AuthContext): Promise<Response>`** — serves the file content for `to_host` transfers:
     1. `requireBoundGuardian(authContext)` auth check
     2. Look up the conversation's `HostTransferProxy` via the pending interaction for this transfer
     3. Call `proxy.getTransferContent(transferId)` — if null, return 404 (consumed or unknown)
     4. Return `new Response(stream, { status: 200, headers: { "Content-Type": "application/octet-stream", "Content-Length": sizeBytes.toString(), "X-Transfer-SHA256": sha256 } })`
     5. The stream is the raw file bytes (ReadableStream from the file buffer)
   - **`handleTransferContentPut(transferId: string, req: Request, authContext: AuthContext): Promise<Response>`** — receives file content for `to_sandbox` transfers:
     1. `requireBoundGuardian(authContext)` auth check
     2. Look up the conversation's `HostTransferProxy` via the pending interaction
     3. Read the request body as `arrayBuffer()` → `Buffer`
     4. Extract `X-Transfer-SHA256` header from request
     5. Call `proxy.receiveTransferContent(transferId, buffer, sha256Header)`
     6. If accepted, return `Response.json({ accepted: true, bytesWritten: buffer.byteLength })`
     7. If error (SHA mismatch, write failure), return appropriate error response
   - **`handleTransferResult(req: Request, authContext: AuthContext): Promise<Response>`** — receives the result callback for `to_host` transfers:
     1. `requireBoundGuardian(authContext)` auth check
     2. Parse JSON body: `{ requestId, isError, bytesWritten?, errorMessage? }`
     3. Peek pending interaction, validate `kind === "host_transfer"`
     4. Consume interaction, call `conversation.resolveHostTransfer(requestId, result)`
     5. Return `Response.json({ accepted: true })`
   - Export `hostTransferRouteDefinitions(): RouteDefinition[]` returning all three routes:
     - `GET transfers/:transferId/content` — binary content download
     - `PUT transfers/:transferId/content` — binary content upload
     - `POST host-transfer-result` — JSON result callback
2. In `assistant/src/runtime/http-server.ts`: import `hostTransferRouteDefinitions` and spread into the route definitions array (near line ~2077).
3. Add tests for each route handler:
   - GET returns 404 for unknown/consumed transferId
   - GET streams correct content with proper headers
   - PUT writes content and verifies SHA-256
   - PUT returns error on SHA-256 mismatch
   - POST resolves pending transfer correctly

### Acceptance criteria
- `GET /v1/transfers/:transferId/content` streams raw file bytes with `application/octet-stream` content type and SHA-256 header
- `PUT /v1/transfers/:transferId/content` accepts raw bytes, verifies SHA-256, writes to sandbox
- `POST /v1/host-transfer-result` resolves the pending to_host transfer
- All endpoints require bound guardian authentication
- TransferIds return 404 after first consumption
- Routes are registered and accessible through the HTTP server

## PR 6: Tool definition, executor, and registry
### Depends on
PR 2, PR 4

### Branch
host-file-xfer/pr-6-tool-definition

### Title
feat(host-transfer): add host_file_transfer tool with local and managed mode execution

### Files
- `assistant/src/tools/host-filesystem/transfer.ts`
- `assistant/src/tools/registry.ts`

### Implementation steps
1. Create `assistant/src/tools/host-filesystem/transfer.ts` implementing the `Tool` interface:
   - `name`: `"host_file_transfer"`
   - `description`: `"Copy a file between the assistant's workspace and the user's host machine. Set direction to 'to_host' to send a workspace file to the host, or 'to_sandbox' to pull a host file into the workspace."`
   - `category`: `"host_filesystem"`
   - `defaultRiskLevel`: `RiskLevel.Medium`
   - `sandboxAutoApprove`: `false`
   - `getDefinition()` returns JSON schema with:
     - `source_path: string` — path to the source file
     - `dest_path: string` — path to the destination file
     - `direction: "to_host" | "to_sandbox"` — transfer direction (enum)
     - `overwrite?: boolean` — default false, error if dest exists
     - `activity: string` — brief user-facing explanation
   - `execute()` method:
     1. Parse and validate input: `source_path`, `dest_path`, `direction`, `overwrite`, `activity`
     2. **Path validation:**
        - `to_host`: resolve `source_path` against sandbox workingDir (relative OK). Validate `dest_path` is absolute. Error if relative dest_path: "dest_path must be absolute for host file access".
        - `to_sandbox`: validate `source_path` is absolute. Resolve `dest_path` against sandbox workingDir (relative OK). Error if relative source_path.
     3. **Source validation:** Check source exists (for `to_host`, check in sandbox). Check it's a file, not a directory — error with: "host_file_transfer operates on files only. For directories, consider tar/zip + transfer." Resolve symlinks via `realpathSync` before reading.
     4. **Destination validation (local mode):** If not using proxy, check if dest exists and `overwrite` is false → error with clear message.
     5. **Local mode** (no proxy or proxy unavailable): `fs.copyFile(resolvedSource, resolvedDest)` with `fs.constants.COPYFILE_EXCL` flag when `overwrite` is false. Create parent directories as needed with `mkdir -p` equivalent.
     6. **Managed mode** (proxy available): delegate to `context.hostTransferProxy`:
        - `to_host`: call `proxy.requestToHost({ sourcePath: resolvedSource, destPath: dest_path, overwrite, conversationId }, signal)`
        - `to_sandbox`: call `proxy.requestToSandbox({ sourcePath: source_path, destPath: resolvedDest, conversationId }, signal)`
     7. Return `ToolExecutionResult` with success message including bytes transferred, or error details.
2. In `assistant/src/tools/registry.ts`: import `hostFileTransferTool` from `./host-filesystem/transfer.js` and add it to the tool definitions array (near the other host filesystem tools).
3. Add unit tests:
   - Local mode: successful copy, overwrite protection, directory source error, symlink resolution, parent directory creation
   - Path validation: relative dest_path for to_host rejected, relative source_path for to_sandbox rejected
   - Managed mode: verify proxy delegation with correct arguments

### Acceptance criteria
- Tool is registered and available in the tool list
- Local mode performs direct `fs.copyFile` with proper path resolution and validation
- Managed mode delegates to `HostTransferProxy` with correct direction-specific arguments
- Source directory detection returns clear error message suggesting tar/zip
- Overwrite protection works (errors when dest exists and overwrite is false)
- Symlinks are resolved before reading (no symlink escape)
- Path validation enforces absolute paths for host-side paths

## PR 7: Swift transfer executor and HostProxyClient methods
### Depends on
PR 3, PR 5

### Branch
host-file-xfer/pr-7-swift-executor

### Title
feat(host-transfer): implement Swift executor for pull/push file transfer with SHA-256 verification

### Files
- `clients/shared/Network/HostToolExecutor.swift`
- `clients/shared/Network/HostProxyClient.swift`

### Implementation steps
1. In `clients/shared/Network/HostProxyClient.swift`:
   - Add `postTransferResult(_ result: HostTransferResultPayload) async -> Bool` method following the existing `postFileResult` pattern — POST to `"assistants/{assistantId}/host-transfer-result"`. Scale timeout based on payload size.
   - Add `pullTransferContent(transferId: String) async throws -> (data: Data, sha256Header: String?)` method — GET from `"assistants/{assistantId}/transfers/\(transferId)/content"` using `GatewayHTTPClient.get()`. Return the raw response data and the `X-Transfer-SHA256` response header. Use a generous timeout scaled by response Content-Length if available.
   - Add `pushTransferContent(transferId: String, data: Data, sha256: String, sourcePath: String) async throws -> Bool` method — PUT to `"assistants/{assistantId}/transfers/\(transferId)/content"` using `GatewayHTTPClient.put(path:body:)` with `data` as body. Set headers: `Content-Type: application/octet-stream`, `X-Transfer-SHA256: sha256`, `X-Transfer-Source-Path: sourcePath`. Scale timeout by data size. Return true on success.
   - Add these methods to the `HostProxyClientProtocol` protocol.
2. In `clients/shared/Network/HostToolExecutor.swift`:
   - Replace the stub `executeHostTransferRequest` with the full implementation:
     ```swift
     @MainActor
     public static func executeHostTransferRequest(_ request: HostTransferRequest) {
         Task.detached {
             // Pre-cancellation check
             if isCancelledAndConsume(request.requestId) { return }

             do {
                 switch request.direction {
                 case "to_host":
                     try await executeToHostTransfer(request)
                 case "to_sandbox":
                     try await executeToSandboxTransfer(request)
                 default:
                     // Post error result
                 }
             } catch {
                 // Post error result
             }
         }
     }
     ```
   - Implement `executeToHostTransfer(_ request: HostTransferRequest)`:
     1. Guard `request.destPath` is non-nil, `request.transferId` is present
     2. Check if `request.overwrite` is false and file at `destPath` already exists → post error result early (avoid downloading bytes only to fail)
     3. Create parent directories for `destPath` using `FileManager.default.createDirectory(withIntermediateDirectories: true)`
     4. Call `HostProxyClient().pullTransferContent(transferId: request.transferId)` to GET the file bytes
     5. Write the received `Data` to `destPath` using `data.write(to: URL(fileURLWithPath: destPath))`
     6. Compute SHA-256 of the written file using `CryptoKit.SHA256.hash(data:)` and compare against `request.sha256` — if mismatch, delete the partial file and post error result
     7. If cancelled during transfer, return without posting result
     8. Post success result via `HostProxyClient().postTransferResult(HostTransferResultPayload(requestId: request.requestId, isError: false, bytesWritten: data.count))`
   - Implement `executeToSandboxTransfer(_ request: HostTransferRequest)`:
     1. Guard `request.sourcePath` is non-nil
     2. Validate source file exists at `sourcePath` using `FileManager.default.fileExists(atPath:)`
     3. Validate source is a file (not directory) using `resourceValues(forKeys: [.isDirectoryKey])`
     4. Read the source file: `Data(contentsOf: URL(fileURLWithPath: sourcePath))`
     5. Compute SHA-256 using `CryptoKit.SHA256.hash(data:)` → hex string
     6. If cancelled, return
     7. Call `HostProxyClient().pushTransferContent(transferId: request.transferId, data: fileData, sha256: sha256Hex, sourcePath: sourcePath)`
     8. No separate result POST needed — the PUT response carries the status
   - Replace the stub `cancelHostTransferRequest` with: `markCancelled(requestId)` + log message (same pattern as `cancelHostFileRequest`)
   - Add SHA-256 helper: `private static func sha256Hex(_ data: Data) -> String` using `import CryptoKit` → `SHA256.hash(data: data).compactMap { String(format: "%02x", $0) }.joined()`
3. Add `import CryptoKit` at the top of `HostToolExecutor.swift`.

### Acceptance criteria
- `to_host` direction: client pulls file via GET, writes to destPath, verifies SHA-256, posts result
- `to_sandbox` direction: client reads source file, computes SHA-256, pushes via PUT
- SHA-256 mismatch on to_host deletes the partial file and posts error
- Overwrite check happens before downloading bytes (to_host)
- Source validation (exists, is file not directory) happens before uploading bytes (to_sandbox)
- Cancellation is properly handled at each stage (pre-check, mid-transfer, post-transfer)
- Parent directory creation for destination path
- Stale results are suppressed after cancellation
