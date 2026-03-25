import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HostToolExecutor")

/// Standalone executor for host tool requests (bash commands, file operations).
/// These run locally on macOS and post results back via `HostProxyClient`.
public enum HostToolExecutor {

    // MARK: - Cancelled Request Tracking

    /// Lock guarding `cancelledRequestIds` and `runningProcesses`.
    private static let lock = NSLock()

    /// Request IDs that have been cancelled, with timestamps for TTL cleanup.
    /// Entries older than 30 seconds are swept on each `markCancelled` call.
    private static var cancelledRequestIds: [String: Date] = [:]

    #if os(macOS)
    /// Currently running bash processes keyed by request ID.
    private static var runningProcesses: [String: Process] = [:]
    #endif

    /// Mark a request ID as cancelled and sweep stale entries (>30s old).
    public static func markCancelled(_ requestId: String) {
        lock.withLock {
            let now = Date()
            cancelledRequestIds[requestId] = now
            // Sweep entries older than 30 seconds
            cancelledRequestIds = cancelledRequestIds.filter { now.timeIntervalSince($0.value) < 30 }
        }
    }

    /// Check if a request ID was cancelled. If found, removes it (consume-once)
    /// and returns `true`. Returns `false` if not cancelled.
    public static func isCancelledAndConsume(_ requestId: String) -> Bool {
        lock.withLock {
            if cancelledRequestIds.removeValue(forKey: requestId) != nil {
                return true
            }
            return false
        }
    }

    // MARK: - Host Bash Execution

    #if os(macOS)
    /// Execute a host bash request locally and post the result back to the daemon.
    /// Spawns `/bin/bash -c -- <command>` via `Foundation.Process`, enforces a
    /// timeout, and collects stdout/stderr.
    @MainActor
    public static func executeHostBashRequest(_ request: HostBashRequest) {
        Task.detached {
            // If already cancelled before we start, skip entirely
            if isCancelledAndConsume(request.requestId) {
                log.debug("Host bash skipped (pre-cancelled) — requestId=\(request.requestId, privacy: .public)")
                return
            }

            let defaultTimeout: Double = 120
            let timeout = request.timeoutSeconds ?? defaultTimeout

            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/bash")
            process.arguments = ["-c", "--", request.command]

            if let workingDir = request.workingDir, !workingDir.isEmpty {
                process.currentDirectoryURL = URL(fileURLWithPath: workingDir)
            } else {
                process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
            }

            // Inject extra environment variables from the daemon (e.g. VELLUM_UNTRUSTED_SHELL)
            // into the subprocess. Merge with the inherited environment so existing vars are preserved.
            if let extraEnv = request.env, !extraEnv.isEmpty {
                var env = ProcessInfo.processInfo.environment
                for (key, value) in extraEnv {
                    env[key] = value
                }
                process.environment = env
            }

            let stdoutPipe = Pipe()
            let stderrPipe = Pipe()
            process.standardOutput = stdoutPipe
            process.standardError = stderrPipe

            // Sendable boxes for values shared across GCD closures
            final class TimedOutBox: @unchecked Sendable {
                private let lock = NSLock()
                private var _value = false
                var value: Bool {
                    get { lock.withLock { _value } }
                    set { lock.withLock { _value = newValue } }
                }
            }
            final class PipeDataBox: @unchecked Sendable {
                private let lock = NSLock()
                private var _value = Data()
                var value: Data {
                    get { lock.withLock { _value } }
                    set { lock.withLock { _value = newValue } }
                }
            }
            let timedOutBox = TimedOutBox()

            let timerSource = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
            timerSource.schedule(deadline: .now() + timeout)
            timerSource.setEventHandler {
                timedOutBox.value = true
                if process.isRunning {
                    process.terminate()
                    DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
                        if process.isRunning {
                            kill(process.processIdentifier, SIGKILL)
                        }
                    }
                }
            }
            timerSource.resume()

            let stdoutBox = PipeDataBox()
            let stderrBox = PipeDataBox()
            let pipeGroup = DispatchGroup()

            pipeGroup.enter()
            DispatchQueue.global().async {
                stdoutBox.value = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
                pipeGroup.leave()
            }

            pipeGroup.enter()
            DispatchQueue.global().async {
                stderrBox.value = stderrPipe.fileHandleForReading.readDataToEndOfFile()
                pipeGroup.leave()
            }

            // Register the process so cancel can terminate it
            lock.withLock { runningProcesses[request.requestId] = process }

            // Re-check cancellation after registration — a cancel may have
            // arrived between the initial check and the store above.
            if isCancelledAndConsume(request.requestId) {
                lock.withLock { runningProcesses.removeValue(forKey: request.requestId) }
                timerSource.cancel()
                // Close write ends so the readDataToEndOfFile() GCD blocks can finish
                try? stdoutPipe.fileHandleForWriting.close()
                try? stderrPipe.fileHandleForWriting.close()
                log.debug("Host bash cancelled before launch — requestId=\(request.requestId, privacy: .public)")
                return
            }

            do {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                    process.terminationHandler = { _ in
                        pipeGroup.notify(queue: .global()) {
                            continuation.resume()
                        }
                    }
                    do {
                        try process.run()
                    } catch {
                        process.terminationHandler = nil
                        try? stdoutPipe.fileHandleForWriting.close()
                        try? stderrPipe.fileHandleForWriting.close()
                        continuation.resume(throwing: error)
                    }
                }
            } catch {
                lock.withLock { runningProcesses.removeValue(forKey: request.requestId) }
                timerSource.cancel()
                log.error("Failed to launch host bash process: \(error.localizedDescription)")
                let result = HostBashResultPayload(
                    requestId: request.requestId,
                    stdout: "",
                    stderr: "Failed to launch process: \(error.localizedDescription)",
                    exitCode: nil,
                    timedOut: false
                )
                if !isCancelledAndConsume(request.requestId) {
                    _ = await HostProxyClient().postBashResult(result)
                }
                return
            }
            lock.withLock { runningProcesses.removeValue(forKey: request.requestId) }
            timerSource.cancel()

            let stdout = String(data: stdoutBox.value, encoding: .utf8) ?? ""
            let stderr = String(data: stderrBox.value, encoding: .utf8) ?? ""
            let exitCode = Int(process.terminationStatus)
            let timedOut = timedOutBox.value

            let result = HostBashResultPayload(
                requestId: request.requestId,
                stdout: stdout,
                stderr: stderr,
                exitCode: timedOut ? nil : exitCode,
                timedOut: timedOut
            )

            log.debug("Host bash completed — requestId=\(request.requestId, privacy: .public) exitCode=\(exitCode) timedOut=\(timedOut)")

            // Suppress stale POST if cancelled while running
            if isCancelledAndConsume(request.requestId) {
                log.debug("Host bash result suppressed (cancelled) — requestId=\(request.requestId, privacy: .public)")
                return
            }
            _ = await HostProxyClient().postBashResult(result)
        }
    }

    /// Cancel an in-flight host bash request: mark it cancelled and terminate
    /// the running process (SIGTERM, then SIGKILL after 2s).
    public static func cancelHostBashRequest(_ requestId: String) {
        markCancelled(requestId)
        let process: Process? = lock.withLock { runningProcesses[requestId] }
        guard let process else { return }
        log.info("Cancelling host bash — requestId=\(requestId, privacy: .public)")
        if process.isRunning {
            process.terminate()
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [process] in
                // SIGKILL if still alive after grace period — check liveness first
                // to avoid killing a reused PID if the process already exited.
                if process.isRunning {
                    kill(process.processIdentifier, SIGKILL)
                }
            }
        }
    }
    #endif

    // MARK: - Host File Execution

    #if os(macOS)
    /// Execute a host file request locally and post the result back to the daemon.
    /// Dispatches by operation: read, write, or edit.
    @MainActor
    public static func executeHostFileRequest(_ request: HostFileRequest) {
        Task.detached {
            // Check cancellation BEFORE performing the file operation to prevent
            // cancelled requests from mutating the filesystem.
            if isCancelledAndConsume(request.requestId) {
                log.debug("Host file skipped (pre-cancelled) — requestId=\(request.requestId, privacy: .public)")
                return
            }

            let result: HostFileResultPayload

            do {
                switch request.operation {
                case "read":
                    let content = try readFile(
                        path: request.path,
                        offset: request.offset,
                        limit: request.limit
                    )
                    result = HostFileResultPayload(
                        requestId: request.requestId,
                        content: content,
                        isError: false
                    )

                case "write":
                    let message = try writeFile(
                        path: request.path,
                        content: request.content ?? ""
                    )
                    result = HostFileResultPayload(
                        requestId: request.requestId,
                        content: message,
                        isError: false
                    )

                case "edit":
                    let message = try editFile(
                        path: request.path,
                        oldString: request.oldString ?? "",
                        newString: request.newString ?? "",
                        replaceAll: request.replaceAll ?? false
                    )
                    result = HostFileResultPayload(
                        requestId: request.requestId,
                        content: message,
                        isError: false
                    )

                default:
                    result = HostFileResultPayload(
                        requestId: request.requestId,
                        content: "Unknown file operation: \(request.operation)",
                        isError: true
                    )
                }
            } catch {
                result = HostFileResultPayload(
                    requestId: request.requestId,
                    content: "File operation failed: \(error.localizedDescription)",
                    isError: true
                )
            }

            log.debug("Host file completed — requestId=\(request.requestId, privacy: .public) op=\(request.operation, privacy: .public) isError=\(result.isError)")

            // Suppress stale POST if cancelled
            if isCancelledAndConsume(request.requestId) {
                log.debug("Host file result suppressed (cancelled) — requestId=\(request.requestId, privacy: .public)")
                return
            }
            _ = await HostProxyClient().postFileResult(result)
        }
    }

    /// Cancel an in-flight host file request. File operations are synchronous
    /// and short-lived so there is no process to kill — we just mark it
    /// cancelled so the result POST is suppressed.
    public static func cancelHostFileRequest(_ requestId: String) {
        markCancelled(requestId)
        log.info("Cancelling host file — requestId=\(requestId, privacy: .public)")
    }

    // MARK: - File Operations

    private static func readFile(path: String, offset: Int?, limit: Int?) throws -> String {
        let fileContent = try String(contentsOfFile: path, encoding: .utf8)
        var lines = fileContent.components(separatedBy: "\n")

        let startIndex = max((offset ?? 1) - 1, 0)
        if startIndex > 0 && startIndex < lines.count {
            lines = Array(lines[startIndex...])
        } else if startIndex >= lines.count {
            return ""
        }

        if let limit, limit > 0, limit < lines.count {
            lines = Array(lines[..<limit])
        }

        let lineNumberStart = max(offset ?? 1, 1)
        let formatted = lines.enumerated().map { index, line in
            let lineNumber = lineNumberStart + index
            let padded = String(repeating: " ", count: max(0, 6 - String(lineNumber).count)) + "\(lineNumber)"
            return "\(padded)  \(line)"
        }

        return formatted.joined(separator: "\n")
    }

    private static func writeFile(path: String, content: String) throws -> String {
        let fileURL = URL(fileURLWithPath: path)
        let parentDir = fileURL.deletingLastPathComponent().path

        try FileManager.default.createDirectory(
            atPath: parentDir,
            withIntermediateDirectories: true,
            attributes: nil
        )

        try content.data(using: .utf8)?.write(to: fileURL)
        return "Successfully wrote to \(path)"
    }

    private static func editFile(path: String, oldString: String, newString: String, replaceAll: Bool) throws -> String {
        guard oldString != newString else {
            throw FileOperationError.sameStrings
        }

        var content = try String(contentsOfFile: path, encoding: .utf8)

        if replaceAll {
            let count = content.components(separatedBy: oldString).count - 1
            guard count > 0 else {
                throw FileOperationError.noMatch
            }
            content = content.replacingOccurrences(of: oldString, with: newString)
            try content.data(using: .utf8)?.write(to: URL(fileURLWithPath: path))
            return "Successfully replaced \(count) occurrence\(count == 1 ? "" : "s") in \(path)"
        } else {
            let count = content.components(separatedBy: oldString).count - 1
            guard count > 0 else {
                throw FileOperationError.noMatch
            }
            guard count == 1 else {
                throw FileOperationError.multipleMatches(count)
            }
            content = content.replacingOccurrences(of: oldString, with: newString)
            try content.data(using: .utf8)?.write(to: URL(fileURLWithPath: path))
            return "Successfully edited \(path)"
        }
    }

    private enum FileOperationError: LocalizedError {
        case noMatch
        case multipleMatches(Int)
        case sameStrings

        var errorDescription: String? {
            switch self {
            case .noMatch:
                return "old_string not found in file"
            case .multipleMatches(let count):
                return "old_string found \(count) times in file — must be unique (use replace_all to replace all occurrences)"
            case .sameStrings:
                return "old_string and new_string are identical — no changes needed"
            }
        }
    }
    #endif
}
