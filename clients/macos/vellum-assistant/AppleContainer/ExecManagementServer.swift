import ContainerizationOS
import Foundation
import Network
import os

private let log = Logger(
    subsystem: Bundle.appBundleIdentifier,
    category: "ExecManagementServer"
)

/// Listens on a Unix domain socket and brokers interactive exec sessions
/// and lifecycle commands for a running Apple Container pod.
///
/// Protocol:
/// 1. Client connects and sends a single JSON line.
///
///    **Exec** (default when `action` is absent):
///    `{"command": ["/bin/bash"], "service": "vellum-assistant", "cols": 120, "rows": 40}\n`
///    → Server replies `{"status": "ok"}\n` then switches to raw PTY relay.
///
///    **Retire**:
///    `{"action": "retire"}\n`
///    → Server triggers the full retire flow (stop pod, archive, cleanup)
///      and replies `{"status": "ok"}\n` or `{"status": "error", "message": "..."}\n`.
///
/// 2. On error, the server always replies with:
///    `{"status": "error", "message": "..."}\n`
@available(macOS 26.0, *)
final class ExecManagementServer: @unchecked Sendable {

    private let socketPath: String
    private let podRuntime: AppleContainersPodRuntime
    private let queue = DispatchQueue(label: "com.vellum.mgmt-socket", qos: .userInitiated)

    private let lock = NSLock()
    private var _listener: NWListener?

    /// Called when a client sends `{"action": "retire"}`. The closure should
    /// perform the full retire flow (stop pod, archive, cleanup, remove
    /// lockfile entry) and throw on failure.
    var onRetire: (@Sendable () async throws -> Void)?

    init(socketPath: String, podRuntime: AppleContainersPodRuntime) {
        self.socketPath = socketPath
        self.podRuntime = podRuntime
    }

    // MARK: - Lifecycle

    /// Starts listening on the Unix domain socket.
    func start() throws {
        // Remove any stale socket file from a previous run.
        try? FileManager.default.removeItem(atPath: socketPath)

        let params = NWParameters()
        params.defaultProtocolStack.transportProtocol = NWProtocolTCP.Options()
        params.requiredLocalEndpoint = .unix(path: socketPath)

        let listener = try NWListener(using: params)

        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                log.info("Management socket listening at \(self.socketPath, privacy: .public)")
                // NWListener reports .ready before the socket file appears on disk.
                // Restrict permissions on a separate queue so we don't block the
                // listener queue — NWListener may need it to finalize the bind.
                DispatchQueue.global(qos: .userInitiated).async {
                    self.restrictSocketPermissions()
                }
            case .failed(let error):
                log.error("Management socket listener failed: \(error.localizedDescription, privacy: .public)")
                self.stopInternal()
            default:
                break
            }
        }

        listener.newConnectionHandler = { [weak self] connection in
            self?.handleConnection(connection)
        }

        lock.withLock { _listener = listener }
        listener.start(queue: queue)
    }

    /// Stops the listener and removes the socket file.
    func stop() {
        stopInternal()
    }

    private func stopInternal() {
        let listener: NWListener? = lock.withLock {
            let l = _listener
            _listener = nil
            return l
        }
        listener?.cancel()
        try? FileManager.default.removeItem(atPath: socketPath)
        log.info("Management socket stopped")
    }

    /// NWListener reports `.ready` before the socket file is created on disk.
    /// Poll up to ~5 s for the file to appear, then set 0600 permissions.
    ///
    /// This MUST run on a queue other than the listener queue because
    /// `NWListener` may need to dispatch work on its queue to finalize the
    /// socket bind. Blocking the listener queue with `usleep` would deadlock.
    private func restrictSocketPermissions() {
        let maxAttempts = 50
        let delayUs: UInt32 = 100_000 // 100 ms
        for attempt in 1...maxAttempts {
            if FileManager.default.fileExists(atPath: socketPath) {
                do {
                    try FileManager.default.setAttributes(
                        [.posixPermissions: 0o600], ofItemAtPath: socketPath
                    )
                    log.info("Management socket permissions set to 0600")
                } catch {
                    // Fail closed: if we can't restrict permissions on a socket
                    // that grants exec access, shut down rather than serve with
                    // potentially world-readable permissions.
                    log.error("Failed to restrict socket permissions: \(error.localizedDescription, privacy: .public)")
                    self.stopInternal()
                }
                return
            }
            if attempt < maxAttempts {
                usleep(delayUs)
            }
        }
        // Don't stop the server — the listener is still functional, we just
        // couldn't verify / chmod the socket file. Log a warning so the
        // operator knows permissions may be wider than intended.
        log.warning("Socket file did not appear after \(maxAttempts) attempts — permissions may not be restricted")
    }

    // MARK: - Connection Handling

    private func handleConnection(_ connection: NWConnection) {
        log.info("Management socket: new connection")

        connection.stateUpdateHandler = { state in
            switch state {
            case .ready:
                log.info("Management socket: connection ready")
            case .failed(let error):
                log.warning("Management socket: connection failed: \(error.localizedDescription, privacy: .public)")
                connection.cancel()
            case .cancelled:
                log.info("Management socket: connection cancelled")
            default:
                break
            }
        }

        connection.start(queue: queue)

        // Read the JSON handshake header (up to 4 KiB, terminated by newline).
        readHandshake(connection)
    }

    /// Reads the initial JSON line from the client and starts an exec session.
    private func readHandshake(_ connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, _, error in
            guard let self else { return }

            if let error {
                log.error("Management socket: handshake read error: \(error.localizedDescription, privacy: .public)")
                connection.cancel()
                return
            }

            guard let data, !data.isEmpty else {
                log.warning("Management socket: empty handshake")
                connection.cancel()
                return
            }

            // Parse JSON handshake — determine the action.
            guard let json = self.parseJSON(data) else {
                self.sendError(connection, message: "Invalid handshake JSON")
                return
            }

            let action = json["action"] as? String ?? "exec"

            switch action {
            case "retire":
                Task { await self.handleRetire(connection: connection) }
            case "exec":
                guard let request = self.parseExecRequest(json) else {
                    self.sendError(connection, message: "Invalid exec request")
                    return
                }
                Task { await self.startExecSession(connection: connection, request: request) }
            default:
                self.sendError(connection, message: "Unknown action: \(action)")
            }
        }
    }

    private struct ExecRequest {
        var command: [String]
        var service: VellumServiceName
        var cols: UInt16
        var rows: UInt16
    }

    private func parseJSON(_ data: Data) -> [String: Any]? {
        var trimmed = data
        if let last = trimmed.last, last == UInt8(ascii: "\n") {
            trimmed = trimmed.dropLast()
        }
        return try? JSONSerialization.jsonObject(with: trimmed) as? [String: Any]
    }

    private func parseExecRequest(_ json: [String: Any]) -> ExecRequest? {
        let command = (json["command"] as? [String]) ?? ["/bin/bash"]
        let serviceName = (json["service"] as? String) ?? VellumServiceName.assistant.rawValue
        let service = VellumServiceName(rawValue: serviceName) ?? .assistant
        let rawCols = json["cols"] as? Int ?? 120
        let rawRows = json["rows"] as? Int ?? 40
        let cols = UInt16(clamping: max(1, rawCols))
        let rows = UInt16(clamping: max(1, rawRows))

        return ExecRequest(command: command, service: service, cols: cols, rows: rows)
    }

    // MARK: - Retire

    private func handleRetire(connection: NWConnection) async {
        guard let onRetire else {
            log.error("Management socket: retire requested but no onRetire handler registered")
            sendError(connection, message: "Retire not supported — no handler registered")
            return
        }

        log.info("Management socket: retire requested by CLI")
        do {
            try await onRetire()
            sendOk(connection)
            log.info("Management socket: retire completed successfully")
        } catch {
            log.error("Management socket: retire failed: \(error.localizedDescription, privacy: .public)")
            sendError(connection, message: error.localizedDescription)
        }
    }

    // MARK: - Exec Session

    private func startExecSession(connection: NWConnection, request: ExecRequest) async {
        let session: AppleContainersPodRuntime.ExecSession
        do {
            session = try await podRuntime.exec(
                service: request.service,
                command: request.command,
                initialSize: Terminal.Size(width: request.cols, height: request.rows)
            )
        } catch {
            log.error("Management socket: exec failed: \(error.localizedDescription, privacy: .public)")
            sendError(connection, message: error.localizedDescription)
            return
        }

        // Send success response.
        sendOk(connection)

        // Relay data bidirectionally between the NWConnection and the host PTY.
        let terminal = session.hostTerminal

        // PTY → client: read from terminal fd, write to NWConnection.
        let readTask = Task.detached { [weak self] in
            guard self != nil else { return }
            let fd = terminal.handle.fileDescriptor
            let bufferSize = 8192
            let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
            defer { buffer.deallocate() }

            while !Task.isCancelled {
                let bytesRead = read(fd, buffer, bufferSize)
                if bytesRead <= 0 {
                    // EOF or error — process exited.
                    break
                }
                let data = Data(bytes: buffer, count: bytesRead)
                let sendResult = await withCheckedContinuation { (cont: CheckedContinuation<NWError?, Never>) in
                    connection.send(content: data, completion: .contentProcessed { error in
                        cont.resume(returning: error)
                    })
                }
                if sendResult != nil {
                    break
                }
            }
            connection.cancel()
        }

        // Client → PTY: read from NWConnection, write to terminal fd.
        // When the client disconnects, this task closes the PTY to deliver
        // SIGHUP to the container process and unblock readTask's blocking read().
        let writeTask = Task.detached { [weak self] in
            guard self != nil else { return }
            let fd = terminal.handle.fileDescriptor
            while !Task.isCancelled {
                let result = await withCheckedContinuation { (cont: CheckedContinuation<(Data?, NWError?), Never>) in
                    connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { data, _, _, error in
                        cont.resume(returning: (data, error))
                    }
                }
                let (data, error) = result
                if error != nil || data == nil || data!.isEmpty {
                    break
                }
                var writeFailed = false
                data!.withUnsafeBytes { rawBuf in
                    var written = 0
                    let total = rawBuf.count
                    while written < total {
                        let result = Darwin.write(fd, rawBuf.baseAddress! + written, total - written)
                        if result <= 0 { writeFailed = true; break }
                        written += result
                    }
                }
                if writeFailed { break }
            }
            // Client disconnected — close the PTY so the container process
            // gets SIGHUP and readTask's blocking read() returns EIO.
            // session.wait()'s defer uses try? on close(), so a double-close
            // from the normal exit path is handled gracefully.
            try? terminal.close()
        }

        // Wait for the process to exit and clean up.
        do {
            try await session.wait()
        } catch {
            log.warning("Management socket: exec session wait error: \(error.localizedDescription, privacy: .public)")
        }

        readTask.cancel()
        writeTask.cancel()
        connection.cancel()
        log.info("Management socket: exec session ended")
    }

    // MARK: - Protocol Helpers

    private func sendOk(_ connection: NWConnection) {
        let response = "{\"status\":\"ok\"}\n".data(using: .utf8)!
        connection.send(content: response, completion: .contentProcessed { error in
            if let error {
                log.warning("Management socket: failed to send OK: \(error.localizedDescription, privacy: .public)")
            }
        })
    }

    private func sendError(_ connection: NWConnection, message: String) {
        let responseDict: [String: Any] = ["status": "error", "message": message]
        guard let jsonData = try? JSONSerialization.data(withJSONObject: responseDict),
              var responseString = String(data: jsonData, encoding: .utf8) else {
            connection.cancel()
            return
        }
        responseString += "\n"
        guard let responseData = responseString.data(using: .utf8) else {
            connection.cancel()
            return
        }
        connection.send(content: responseData, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}
