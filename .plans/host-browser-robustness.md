# Host Browser Executor Robustness Fixes

## Overview
Fix two robustness gaps in the macOS host-browser transport (`HostBrowserExecutor`): (1) make `cdpSessionId` fail closed instead of silently falling back to an unrelated tab, and (2) add cooperative cancellation to WebSocket command execution so in-flight cancels resolve promptly instead of waiting for full timeout. Both changes harden the CDP proxy path against stale session handles and hanging requests.

## PR 1: Make cdpSessionId fail closed on target mismatch
### Depends on
None

### Branch
host-browser-robust/pr-1-cdp-fail-closed

### Title
fix(host-browser): fail closed when cdpSessionId does not match any target

### Files
- clients/shared/Network/HostBrowserExecutor.swift
- clients/shared/Tests/HostBrowserExecutorTests.swift

### Implementation steps
1. In `HostBrowserExecutor.swift`, modify the target selection closure in `run(_:)` (lines 146-156). When `request.cdpSessionId` is present, attempt to match it against `pageTargets` by target `id`. If no match is found, return `nil` from the closure **instead of** falling back to `pageTargets.first`. The existing `pageTargets.first` fallback must only execute when `cdpSessionId` is `nil`.

   Replace the current closure body:
   ```swift
   let selectedTarget: [String: Any]? = {
       if let sessionId = request.cdpSessionId {
           if let matched = pageTargets.first(where: { ($0["id"] as? String) == sessionId }) {
               return matched
           }
           // Fail closed: cdpSessionId was authoritative but no target matched.
           // Do NOT fall back to first page target — that would run the command
           // on the wrong tab.
           log.warning("cdpSessionId '\(sessionId, privacy: .public)' did not match any target id; failing closed")
           return nil
       }
       // No cdpSessionId provided — fall back to first page target (existing behavior).
       return pageTargets.first
   }()
   ```

2. Update the `guard let target = selectedTarget` error message (lines 158-165) to distinguish between two failure modes: (a) `cdpSessionId` was provided but no matching target was found (use error code `"cdp_session_not_found"`), and (b) no page targets exist at all (keep existing `"unreachable"` code). Add a conditional check:
   ```swift
   guard let target = selectedTarget,
         let wsURL = target["webSocketDebuggerUrl"] as? String else {
       if let sessionId = request.cdpSessionId {
           // cdpSessionId was provided but did not match any target — fail closed
           // with a specific error code so the backend can distinguish this from
           // "Chrome is not running".
           return Self.transportError(
               requestId: request.requestId,
               code: "cdp_session_not_found",
               message: "cdpSessionId '\(sessionId)' did not match any page target in /json/list. The target may have been closed or navigated."
           )
       }
       return Self.transportError(
           requestId: request.requestId,
           code: "unreachable",
           message: "No debuggable page target found at \(host):\(port). Ensure Chrome is running with --remote-debugging-port=\(port)."
       )
   }
   ```

3. Update the doc comment on the target selection block (currently lines 139-144) to document that `cdpSessionId` is authoritative when present and that no fallback occurs:
   ```swift
   // Step 2: Select a page target.
   // When cdpSessionId is provided, it is authoritative — only the target
   // whose `id` matches is used. If no target matches, the request fails
   // closed with a structured error (cdp_session_not_found) instead of
   // silently running on an unrelated tab. This mirrors the Chrome
   // extension's resolveTarget() which uses cdpSessionId for target
   // resolution (NOT as a CDP protocol sessionId).
   // When no cdpSessionId is provided, fall back to the first page target.
   ```

4. In `HostBrowserExecutorTests.swift`, add a new test `testRunWithUnmatchedCdpSessionIdReturnsStructuredError()` that verifies the fail-closed behavior. The test should:
   - Create a `HostBrowserExecutor` instance.
   - Build a request with a `cdpSessionId` value (e.g. `"NONEXISTENT_TARGET_ID"`).
   - Call `executor.run(request)` — since no local Chrome is running, the `/json/list` fetch will fail with `unreachable` before target matching occurs. This is acceptable for unit testing the error path without Chrome. To test the target-mismatch path specifically, a comment should note that integration tests with a running Chrome instance are needed for full coverage.
   - Assert the result has `isError: true`.
   - Assert the error code is `"unreachable"` (because Chrome is not running in the unit test environment).
   - Add a second test or a doc comment explaining that when Chrome IS running but the cdpSessionId doesn't match any target, the error code would be `"cdp_session_not_found"` — this is the behavior being added but requires integration testing to fully verify.

5. Add a test `testRunWithoutCdpSessionIdFallsBackToFirstTarget()` that documents the preserved fallback behavior when `cdpSessionId` is absent. This test calls `executor.run(request)` with no `cdpSessionId` — it will get `unreachable` (no Chrome running), confirming the code path doesn't crash and follows the first-page-target fallback logic.

### Acceptance criteria
- When `cdpSessionId` is present and no target matches, `run()` returns a structured error with `isError: true` and code `"cdp_session_not_found"` — it does NOT silently execute on the first page target.
- When `cdpSessionId` is absent, existing first-page-target fallback behavior is preserved exactly as before.
- New regression tests pass.
- Existing `HostBrowserExecutorTests` continue to pass.

## PR 2: Add cooperative cancellation to WebSocket command execution
### Depends on
None

### Branch
host-browser-robust/pr-2-cooperative-cancel

### Title
fix(host-browser): add cooperative cancellation to CDP WebSocket execution

### Files
- clients/shared/Network/HostBrowserExecutor.swift
- clients/shared/Tests/HostBrowserExecutorTests.swift

### Implementation steps
1. In `HostBrowserExecutor.swift`, replace the `withCheckedThrowingContinuation` call in `sendCDPCommand` (line 297) with `withTaskCancellationHandler` wrapping `withCheckedThrowingContinuation`. The cancellation handler should:
   - Call `wsTask.cancel(with: .goingAway, reason: nil)` to immediately tear down the WebSocket.
   - Call `session.invalidateAndCancel()` to clean up the URLSession.
   - Call `timeoutWork.cancel()` to prevent the timeout from firing after cancellation.
   - Call `resumeOnce(.failure(CancellationError()))` to resume the continuation exactly once.

   The structure should be:
   ```swift
   return try await withTaskCancellationHandler {
       try await withCheckedThrowingContinuation { continuation in
           // ... existing continuation body (session, wsTask, lock, resumed, resumeOnce, timeout, send, receive) ...
       }
   } onCancel: {
       // Cooperative cancellation: immediately tear down the WS and
       // resume the continuation so the caller doesn't wait for
       // timeout/receive completion.
       // Note: The resumeOnce closure already has double-resume
       // protection via the NSLock-guarded `resumed` flag, so this
       // is safe even if the continuation is already being resumed
       // from another code path.
   }
   ```

   However, there is a subtlety: the `onCancel` closure runs immediately when `withTaskCancellationHandler` is entered if the task is already cancelled, and it runs concurrently with the continuation body. The `resumeOnce` closure, `wsTask`, `session`, and `timeoutWork` are all created inside the continuation body, so they may not exist yet when `onCancel` fires.

   To handle this, extract the mutable state into a thread-safe wrapper class declared outside the continuation:
   ```swift
   final class CancelState: @unchecked Sendable {
       let lock = NSLock()
       var resumed = false
       var wsTask: URLSessionWebSocketTask?
       var session: URLSession?
       var timeoutWork: DispatchWorkItem?
       var continuation: CheckedContinuation<String, Error>?

       func resumeOnce(with result: Result<String, Error>) {
           lock.lock()
           let alreadyResumed = resumed
           if !alreadyResumed { resumed = true }
           lock.unlock()
           guard !alreadyResumed else { return }
           wsTask?.cancel(with: .normalClosure, reason: nil)
           session?.invalidateAndCancel()
           timeoutWork?.cancel()
           continuation?.resume(with: result)
       }

       func teardown() {
           lock.lock()
           let alreadyResumed = resumed
           if !alreadyResumed { resumed = true }
           lock.unlock()
           guard !alreadyResumed else { return }
           wsTask?.cancel(with: .goingAway, reason: nil)
           session?.invalidateAndCancel()
           timeoutWork?.cancel()
           continuation?.resume(throwing: CancellationError())
       }
   }
   ```

   Create the `CancelState` instance before `withTaskCancellationHandler`. The `onCancel` closure calls `state.teardown()`. Inside the continuation body, assign `state.continuation`, `state.wsTask`, `state.session`, and `state.timeoutWork` as they are created, and use `state.resumeOnce(with:)` everywhere the existing `resumeOnce` closure is used.

2. Update the `run(_:)` method to propagate `CancellationError` from `sendCDPCommand`. Currently the catch chain handles `CDPError` and generic `Error`. Add a catch for `CancellationError` (or check `Task.isCancelled` after the call) that returns early without producing a result, since the `execute(_:)` method already checks for cancellation before posting:
   ```swift
   } catch is CancellationError {
       return Self.transportError(
           requestId: request.requestId,
           code: "cancelled",
           message: "CDP command cancelled"
       )
   }
   ```

3. Update the doc comment on `sendCDPCommand` to document cooperative cancellation behavior:
   ```swift
   /// Send a single CDP command over WebSocket and return the JSON result
   /// string. Opens the connection, sends the command, waits for the
   /// matching response (by `id`), and closes the connection.
   ///
   /// Cancellation is cooperative: when the enclosing Task is cancelled,
   /// the WebSocket and URLSession are torn down immediately and the
   /// continuation resumes with `CancellationError()`. This ensures that
   /// `cancel(requestId:)` takes effect promptly instead of waiting for
   /// the full timeout or a WebSocket receive to complete.
   ```

4. Update the doc comment on `cancel(_:)` to note that cancellation is now faster:
   ```swift
   /// Cancel an in-flight host browser request: mark it cancelled and cancel
   /// the Swift Task so in-flight network calls are interrupted.
   ///
   /// Cancellation is cooperative — the in-flight `sendCDPCommand` WebSocket
   /// connection is torn down immediately when the Task is cancelled, so
   /// the result is available (and suppressed) without waiting for timeout.
   ```

5. In `HostBrowserExecutorTests.swift`, add a test `testCancelDuringExecutionResolvesPromptly()` that verifies cooperative cancellation:
   - Create a `MockHostProxyClient` and `HostBrowserExecutor`.
   - Build a request with a long `timeoutSeconds` (e.g. 30).
   - Call `executor.execute(request)` to start the task.
   - Wait a short time (`Task.sleep(nanoseconds: 50_000_000)` — 50ms) to let execution begin.
   - Call `executor.cancel(request.requestId)`.
   - Wait a bounded time (e.g. 2 seconds) and verify the task has completed (no result posted, or a transport error was posted). The key assertion: the test completes well before the 30-second timeout, proving cancellation interrupted the WebSocket wait.
   - Use `XCTAssertTrue(mockClient.postedBrowserResults.isEmpty, ...)` or if a result was posted, assert it's a transport error — not a success from the wrong tab.

### Acceptance criteria
- Cancelling an in-flight host-browser request via `cancel(requestId:)` tears down the WebSocket immediately and does not wait for the full timeout.
- The double-resume protection (`resumed` flag + NSLock) is preserved — concurrent cancellation and normal completion never double-resume the continuation.
- `cancel(requestId:)` still suppresses stale result POSTs via the `cancelledRequestIds` mechanism (existing behavior preserved).
- Existing cancellation tests continue to pass.
- New test verifies prompt cancellation behavior.
