import ContainerizationOS
import Foundation
import Network
import os

private let log = Logger(
    subsystem: Bundle.appBundleIdentifier,
    category: "ExecManagementServer"
)

/// Listens on a Unix domain socket and brokers interactive exec sessions
/// into a running Apple Container pod.
///
/// Protocol:
/// 1. Client connects and sends a single JSON line:
///    `{"command": ["/bin/sh"], "service": "vellum-assistant", "cols": 120, "rows": 40}\n`
/// 2. Server replies with a JSON line:
///    `{"status": "ok"}\n`  or  `{"status": "error", "message": "..."}\n`
/// 3. On success the connection switches to raw mode — bytes flow
///    bidirectionally between the client and the container PTY.
@available(macOS 26.0, *)
final class ExecManagementServer: @unchecked Sendable {

    private let socketPath: String
    private let podRuntime: AppleContainersPodRuntime
    private let queue = DispatchQueue(label: "com.vellum.mgmt-socket", qos: .userInitiated)

    private let lock = NSLock()
    private var _listener: NWListener?

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

        // Restrict socket to current user.
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600], ofItemAtPath: socketPath
        )
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

            // Parse JSON handshake.
            guard let request = self.parseHandshake(data) else {
                self.sendError(connection, message: "Invalid handshake JSON")
                return
            }

            // Start the exec session on a Task.
            Task {
                await self.startExecSession(connection: connection, request: request)
            }
        }
    }

    private struct ExecRequest {
        var command: [String]
        var service: VellumServiceName
        var cols: UInt16
        var rows: UInt16
    }

    private func parseHandshake(_ data: Data) -> ExecRequest? {
        // Strip trailing newline if present.
        var trimmed = data
        if let last = trimmed.last, last == UInt8(ascii: "\n") {
            trimmed = trimmed.dropLast()
        }

        guard let json = try? JSONSerialization.jsonObject(with: trimmed) as? [String: Any] else {
            return nil
        }

        let command = (json["command"] as? [String]) ?? ["/bin/sh"]
        let serviceName = (json["service"] as? String) ?? VellumServiceName.assistant.rawValue
        let service = VellumServiceName(rawValue: serviceName) ?? .assistant
        let cols = UInt16(json["cols"] as? Int ?? 120)
        let rows = UInt16(json["rows"] as? Int ?? 40)

        return ExecRequest(command: command, service: service, cols: cols, rows: rows)
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
            let fd = terminal.fileDescriptor
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
        let writeTask = Task.detached { [weak self] in
            guard self != nil else { return }
            let fd = terminal.fileDescriptor
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
                data!.withUnsafeBytes { rawBuf in
                    var written = 0
                    let total = rawBuf.count
                    while written < total {
                        let result = Darwin.write(fd, rawBuf.baseAddress! + written, total - written)
                        if result <= 0 { break }
                        written += result
                    }
                }
            }
            // Client disconnected — close the PTY so the process gets SIGHUP.
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
        let escaped = message.replacingOccurrences(of: "\"", with: "\\\"")
        let response = "{\"status\":\"error\",\"message\":\"\(escaped)\"}\n".data(using: .utf8)!
        connection.send(content: response, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}
