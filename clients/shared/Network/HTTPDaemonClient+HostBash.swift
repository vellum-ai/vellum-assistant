import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HostBash")

// MARK: - Host Bash Proxy Execution

extension HTTPTransport {

    /// Post the result of a host bash execution back to the daemon.
    func postHostBashResult(_ result: HostBashResultPayload, isRetry: Bool = false) async {
        guard let url = buildURL(for: .hostBashResult) else {
            log.error("Failed to build URL for host_bash_result")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        applyAuth(&request)

        do {
            request.httpBody = try encoder.encode(result)
            let (data, response) = try await URLSession.shared.data(for: request)

            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    switch refreshResult {
                    case .success:
                        await postHostBashResult(result, isRetry: true)
                    case .terminalFailure:
                        break
                    case .transientFailure:
                        log.error("Host bash result failed: authentication error after 401 refresh")
                    }
                } else if http.statusCode != 200 {
                    log.error("Host bash result failed (\(http.statusCode))")
                }
            }
        } catch {
            log.error("Host bash result error: \(error.localizedDescription)")
        }
    }

    #if os(macOS)
    /// Execute a host bash request locally and post the result back to the daemon.
    /// Spawns `/bin/bash -c -- <command>` via `Foundation.Process`, enforces a
    /// timeout, and collects stdout/stderr.
    func executeHostBashRequest(_ request: HostBashRequest) {
        Task.detached {
            let maxTimeout: Double = 600
            let defaultTimeout: Double = 120
            let timeout = min(request.timeoutSeconds ?? defaultTimeout, maxTimeout)

            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/bash")
            process.arguments = ["-c", "--", request.command]

            if let workingDir = request.workingDir, !workingDir.isEmpty {
                process.currentDirectoryURL = URL(fileURLWithPath: workingDir)
            } else {
                process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
            }

            let stdoutPipe = Pipe()
            let stderrPipe = Pipe()
            process.standardOutput = stdoutPipe
            process.standardError = stderrPipe

            // Use a sendable box for the timeout flag shared between the timer
            // and the termination handler.
            final class TimedOutBox: @unchecked Sendable {
                private let lock = NSLock()
                private var _value = false
                var value: Bool {
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

            do {
                try process.run()
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
                await self.postHostBashResult(result)
                return
            }

            // Read stdout and stderr concurrently to avoid deadlock.
            // If we read sequentially and the process fills one pipe's buffer
            // (~64 KB), the process blocks on that write, the other pipe never
            // reaches EOF, and this thread hangs forever.
            var stdoutData = Data()
            var stderrData = Data()
            let pipeGroup = DispatchGroup()

            pipeGroup.enter()
            DispatchQueue.global().async {
                stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
                pipeGroup.leave()
            }

            pipeGroup.enter()
            DispatchQueue.global().async {
                stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
                pipeGroup.leave()
            }

            process.waitUntilExit()
            pipeGroup.wait()
            timerSource.cancel()

            let stdout = String(data: stdoutData, encoding: .utf8) ?? ""
            let stderr = String(data: stderrData, encoding: .utf8) ?? ""
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
            await self.postHostBashResult(result)
        }
    }
    #endif
}
