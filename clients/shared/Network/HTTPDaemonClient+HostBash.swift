import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HostBash")

// MARK: - Host Bash Proxy Execution

extension HTTPTransport {

    #if os(macOS)
    /// Execute a host bash request locally and post the result back to the daemon.
    /// Spawns `/bin/bash -c -- <command>` via `Foundation.Process`, enforces a
    /// timeout, and collects stdout/stderr.
    public func executeHostBashRequest(_ request: HostBashRequest) {
        Task.detached {
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
            // (AGENTS.md pitfalls: use lock-protected boxes instead of
            // mutable vars captured in DispatchGroup callbacks).
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

            // Set up timeout timer
            let timerSource = DispatchSource.makeTimerSource(queue: DispatchQueue.global())
            timerSource.schedule(deadline: .now() + timeout)
            timerSource.setEventHandler {
                timedOutBox.value = true
                if process.isRunning {
                    process.terminate()
                    // Give the process a moment to terminate gracefully, then SIGKILL
                    DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
                        if process.isRunning {
                            kill(process.processIdentifier, SIGKILL)
                        }
                    }
                }
            }
            timerSource.resume()

            // Read stdout and stderr concurrently to avoid deadlock.
            // If we read sequentially and the process fills one pipe's buffer
            // (~64 KB), the process blocks on that write, the other pipe never
            // reaches EOF, and this thread hangs forever.
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

            // Use terminationHandler + continuation instead of waitUntilExit()
            // so the cooperative thread pool thread is suspended (not blocked)
            // for the duration of the bash command. terminationHandler is set
            // before process.run() to avoid a race where the process exits
            // before the handler is installed.
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
                        // Clear the handler since we never started
                        process.terminationHandler = nil
                        // Close the write ends so readDataToEndOfFile() returns
                        // immediately, unblocking the GCD reader threads.
                        try? stdoutPipe.fileHandleForWriting.close()
                        try? stderrPipe.fileHandleForWriting.close()
                        continuation.resume(throwing: error)
                    }
                }
            } catch {
                timerSource.cancel()
                log.error("Failed to launch host bash process: \(error.localizedDescription)")
                let result = HostBashResultPayload(
                    requestId: request.requestId,
                    stdout: "",
                    stderr: "Failed to launch process: \(error.localizedDescription)",
                    exitCode: nil,
                    timedOut: false
                )
                _ = await HostProxyClient().postBashResult(result)
                return
            }
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
            _ = await HostProxyClient().postBashResult(result)
        }
    }
    #endif
}
