#if os(macOS) && !DEBUG
import Foundation
import Network
import os

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "KeychainBrokerServer"
)

/// UDS server that exposes keychain operations to the daemon process via
/// newline-delimited JSON over a Unix domain socket.
///
/// The broker generates a random auth token on each launch and writes it
/// to `~/.vellum/protected/keychain-broker.token` with `0o600` permissions.
/// Only processes that can read that file (same user) can authenticate.
///
/// Only compiled for release builds (`!DEBUG`). Debug builds skip the broker
/// entirely so developers never see the keychain authorization modal on rebuild.
final class KeychainBrokerServer {

    // MARK: - Paths

    private var vellumDir: URL {
        if let baseDir = ProcessInfo.processInfo.environment["BASE_DATA_DIR"]?
            .trimmingCharacters(in: .whitespacesAndNewlines), !baseDir.isEmpty {
            return URL(fileURLWithPath: baseDir).appendingPathComponent(".vellum")
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".vellum")
    }

    private var socketPath: String {
        vellumDir.appendingPathComponent("keychain-broker.sock").path
    }

    private var protectedDir: URL {
        vellumDir.appendingPathComponent("protected")
    }

    private var tokenFileURL: URL {
        protectedDir.appendingPathComponent("keychain-broker.token")
    }

    // MARK: - State

    private var listener: NWListener?
    private var connections: [NWConnection] = []
    private var authToken: String?

    /// Per-connection receive buffers keyed by object identity.
    private var receiveBuffers: [ObjectIdentifier: Data] = [:]

    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    // MARK: - Lifecycle

    func start() {
        // Generate auth token.
        var bytes = [UInt8](repeating: 0, count: 32)
        let rngStatus = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard rngStatus == errSecSuccess else {
            log.error("SecRandomCopyBytes failed with status \(rngStatus) — aborting broker start")
            return
        }
        let token = bytes.map { String(format: "%02x", $0) }.joined()
        authToken = token

        // Write token to protected directory.
        let fm = FileManager.default
        do {
            if !fm.fileExists(atPath: protectedDir.path) {
                try fm.createDirectory(at: protectedDir, withIntermediateDirectories: true)
                // Set directory permissions to owner-only.
                try fm.setAttributes(
                    [.posixPermissions: 0o700],
                    ofItemAtPath: protectedDir.path
                )
            }
            try token.write(to: tokenFileURL, atomically: true, encoding: .utf8)
            try fm.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: tokenFileURL.path
            )
        } catch {
            log.error("Failed to write auth token: \(error.localizedDescription)")
            return
        }

        // Remove stale socket from a previous unclean exit.
        unlink(socketPath)

        // Create NWListener on Unix domain socket.
        let params = NWParameters()
        params.defaultProtocolStack.transportProtocol = NWProtocolTCP.Options()
        params.requiredLocalEndpoint = NWEndpoint.unix(path: socketPath)

        do {
            listener = try NWListener(using: params)
        } catch {
            log.error("Failed to create NWListener: \(error.localizedDescription)")
            return
        }

        listener?.newConnectionHandler = { [weak self] conn in
            self?.handleNewConnection(conn)
        }

        let path = socketPath
        listener?.stateUpdateHandler = { state in
            switch state {
            case .ready:
                log.info("Keychain broker listening on \(path, privacy: .public)")
            case .failed(let error):
                log.error("Keychain broker listener failed: \(error.localizedDescription)")
            case .cancelled:
                log.info("Keychain broker listener cancelled")
            default:
                break
            }
        }

        listener?.start(queue: .main)
    }

    func stop() {
        // Cancel all client connections.
        for conn in connections {
            conn.cancel()
        }
        connections.removeAll()
        receiveBuffers.removeAll()

        // Cancel the listener.
        listener?.cancel()
        listener = nil

        // Clean up socket and token files.
        unlink(socketPath)
        try? FileManager.default.removeItem(at: tokenFileURL)

        authToken = nil
        log.info("Keychain broker stopped")
    }

    // MARK: - Connection Handling

    private func handleNewConnection(_ conn: NWConnection) {
        connections.append(conn)
        let connId = ObjectIdentifier(conn)
        receiveBuffers[connId] = Data()

        conn.stateUpdateHandler = { [weak self, weak conn] state in
            guard let self, let conn else { return }
            switch state {
            case .ready:
                log.debug("Broker client connected")
            case .failed(let error):
                log.error("Broker client connection failed: \(error.localizedDescription)")
                self.removeConnection(conn)
            case .cancelled:
                self.removeConnection(conn)
            default:
                break
            }
        }

        conn.start(queue: .main)
        receiveData(on: conn)
    }

    private func removeConnection(_ conn: NWConnection) {
        let connId = ObjectIdentifier(conn)
        receiveBuffers.removeValue(forKey: connId)
        connections.removeAll { $0 === conn }
    }

    // MARK: - Receive Loop

    /// Newline-delimited JSON receive loop.
    private func receiveData(on conn: NWConnection) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self, weak conn] content, _, isComplete, error in
            guard let self, let conn else { return }

            let connId = ObjectIdentifier(conn)

            if let data = content, !data.isEmpty {
                self.receiveBuffers[connId, default: Data()].append(data)

                let newline = UInt8(0x0A)
                while let buffer = self.receiveBuffers[connId],
                      let newlineIndex = buffer.firstIndex(of: newline) {
                    let lineData = buffer[buffer.startIndex..<newlineIndex]
                    self.receiveBuffers[connId] = Data(buffer[(newlineIndex + 1)...])

                    guard !lineData.isEmpty else { continue }

                    self.handleLine(Data(lineData), on: conn)
                }
            }

            if isComplete || error != nil {
                self.removeConnection(conn)
            } else {
                self.receiveData(on: conn)
            }
        }
    }

    // MARK: - Request / Response Types

    private struct Request: Decodable {
        let v: Int
        let id: String
        let token: String
        let method: String
        let params: Params?

        struct Params: Decodable {
            let account: String?
            let value: String?
        }
    }

    private struct Response: Encodable {
        let id: String
        let ok: Bool
        let result: AnyCodable?
        let error: ErrorPayload?

        struct ErrorPayload: Encodable {
            let code: String
            let message: String
        }
    }

    /// Type-erased Encodable wrapper for response results.
    private struct AnyCodable: Encodable {
        private let _encode: (Encoder) throws -> Void

        init<T: Encodable>(_ value: T) {
            _encode = { encoder in try value.encode(to: encoder) }
        }

        func encode(to encoder: Encoder) throws {
            try _encode(encoder)
        }
    }

    // MARK: - Dispatch

    private func handleLine(_ data: Data, on conn: NWConnection) {
        let request: Request
        do {
            request = try decoder.decode(Request.self, from: data)
        } catch {
            log.error("Failed to decode broker request: \(error.localizedDescription)")
            // Cannot respond without an id, so just drop the malformed request.
            return
        }

        // Validate protocol version.
        guard request.v == 1 else {
            sendError(id: request.id, code: "INVALID_REQUEST", message: "Unsupported protocol version: \(request.v)", on: conn)
            return
        }

        // Validate auth token.
        guard request.token == authToken else {
            sendError(id: request.id, code: "UNAUTHORIZED", message: "Invalid auth token", on: conn)
            return
        }

        switch request.method {
        case "broker.ping":
            sendSuccess(id: request.id, result: PingResult(pong: true), on: conn)

        case "key.get":
            guard let account = request.params?.account, !account.isEmpty else {
                sendError(id: request.id, code: "INVALID_REQUEST", message: "Missing 'account' param", on: conn)
                return
            }
            if let value = KeychainBrokerService.get(account: account) {
                sendSuccess(id: request.id, result: GetResult(found: true, value: value), on: conn)
            } else {
                sendSuccess(id: request.id, result: GetResult(found: false, value: nil), on: conn)
            }

        case "key.set":
            guard let account = request.params?.account, !account.isEmpty,
                  let value = request.params?.value else {
                sendError(id: request.id, code: "INVALID_REQUEST", message: "Missing 'account' or 'value' param", on: conn)
                return
            }
            let setStatus = KeychainBrokerService.set(account: account, value: value)
            if setStatus == errSecSuccess {
                sendSuccess(id: request.id, result: SetResult(stored: true), on: conn)
            } else {
                sendError(id: request.id, code: "KEYCHAIN_ERROR", message: "Keychain set failed (OSStatus \(setStatus))", on: conn)
            }

        case "key.delete":
            guard let account = request.params?.account, !account.isEmpty else {
                sendError(id: request.id, code: "INVALID_REQUEST", message: "Missing 'account' param", on: conn)
                return
            }
            if KeychainBrokerService.delete(account: account) {
                sendSuccess(id: request.id, result: DeleteResult(deleted: true), on: conn)
            } else {
                sendError(id: request.id, code: "KEYCHAIN_ERROR", message: "SecItemDelete failed", on: conn)
            }

        case "key.list":
            let accounts = KeychainBrokerService.list()
            sendSuccess(id: request.id, result: ListResult(accounts: accounts), on: conn)

        default:
            sendError(id: request.id, code: "INVALID_REQUEST", message: "Unknown method: \(request.method)", on: conn)
        }
    }

    // MARK: - Result Types

    private struct PingResult: Encodable {
        let pong: Bool
    }

    private struct GetResult: Encodable {
        let found: Bool
        let value: String?
    }

    private struct SetResult: Encodable {
        let stored: Bool
    }

    private struct DeleteResult: Encodable {
        let deleted: Bool
    }

    private struct ListResult: Encodable {
        let accounts: [String]
    }

    // MARK: - Send Helpers

    private func sendSuccess<T: Encodable>(id: String, result: T, on conn: NWConnection) {
        let response = Response(id: id, ok: true, result: AnyCodable(result), error: nil)
        send(response, on: conn)
    }

    private func sendError(id: String, code: String, message: String, on conn: NWConnection) {
        let response = Response(id: id, ok: false, result: nil, error: .init(code: code, message: message))
        send(response, on: conn)
    }

    private func send(_ response: Response, on conn: NWConnection) {
        do {
            var data = try encoder.encode(response)
            data.append(0x0A) // newline delimiter
            conn.send(content: data, completion: .contentProcessed { error in
                if let error {
                    log.error("Failed to send broker response: \(error.localizedDescription)")
                }
            })
        } catch {
            log.error("Failed to encode broker response: \(error.localizedDescription)")
        }
    }
}
#endif
