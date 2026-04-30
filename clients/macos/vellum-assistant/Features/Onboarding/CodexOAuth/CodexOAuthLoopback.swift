import Foundation
import Network
import os

private let log = Logger(
    subsystem: Bundle.appBundleIdentifier,
    category: "CodexOAuthLoopback"
)

enum CodexOAuthLoopbackError: Error, LocalizedError {
    case portInUse
    case stateMismatch
    case missingCode
    case oauthError(String)
    case timeout
    case cancelled
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .portInUse:
            return "Port 1455 is in use. Close any other Codex sign-in (e.g. Codex CLI) and try again."
        case .stateMismatch:
            return "OAuth state mismatch — please retry sign-in."
        case .missingCode:
            return "OAuth callback missing authorization code."
        case .oauthError(let msg):
            return "OAuth provider returned error: \(msg)"
        case .timeout:
            return "Timed out waiting for browser callback."
        case .cancelled:
            return "Sign-in cancelled."
        case .transport(let msg):
            return "Network error during OAuth callback: \(msg)"
        }
    }
}

/// One-shot HTTP/1.1 listener on 127.0.0.1:1455 used to capture OpenAI's
/// PKCE OAuth redirect. After the first callback (or error) the listener
/// closes itself.
final class CodexOAuthLoopback: @unchecked Sendable {
    private let host = "127.0.0.1"
    private let port: NWEndpoint.Port = 1455
    private let expectedState: String
    private let queue = DispatchQueue(label: "com.vellum.codex-oauth-loopback", qos: .userInitiated)

    private static let maxHeaderBytes = 64 * 1024

    private let lock = NSLock()
    private var listener: NWListener?
    private var connections: [NWConnection] = []
    private var continuation: CheckedContinuation<String, Error>?
    private var readyContinuation: CheckedContinuation<Void, Error>?
    private var didFinish = false

    init(expectedState: String) {
        self.expectedState = expectedState
    }

    /// Bind the loopback listener and wait for it to reach `.ready`. Must be
    /// called before launching the browser — a fast OAuth redirect can
    /// otherwise hit `localhost:1455` before the socket is bound.
    func startListening() async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            lock.withLock { self.readyContinuation = cont }
            do {
                try setupListener()
            } catch {
                resumeReady(.failure(mapBindError(error)))
            }
        }
    }

    func waitForCallback(timeout: TimeInterval) async throws -> String {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<String, Error>) in
            lock.withLock { self.continuation = cont }
            let timeoutSeconds = max(1, Int(timeout))
            queue.asyncAfter(deadline: .now() + .seconds(timeoutSeconds)) { [weak self] in
                self?.finish(.failure(CodexOAuthLoopbackError.timeout))
            }
        }
    }

    func stop() {
        finish(.failure(CodexOAuthLoopbackError.cancelled))
    }

    // MARK: - Private

    private func setupListener() throws {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: NWEndpoint.Host(host), port: port)
        let listener = try NWListener(using: params)

        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.resumeReady(.success(()))
            case .failed(let error):
                let mapped = self.mapBindError(error)
                if !self.resumeReady(.failure(mapped)) {
                    self.finish(.failure(mapped))
                }
            default:
                break
            }
        }

        listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection)
        }

        lock.withLock { self.listener = listener }
        listener.start(queue: queue)
    }

    /// Resumes the bind continuation exactly once. Returns `true` if this call
    /// consumed it (so callers can tell pre-ready failures from post-ready ones).
    @discardableResult
    private func resumeReady(_ result: Result<Void, CodexOAuthLoopbackError>) -> Bool {
        let pending: CheckedContinuation<Void, Error>?
        lock.lock()
        pending = readyContinuation
        readyContinuation = nil
        lock.unlock()
        guard let pending else { return false }
        switch result {
        case .success: pending.resume()
        case .failure(let err): pending.resume(throwing: err)
        }
        return true
    }

    private func handle(_ connection: NWConnection) {
        lock.withLock { connections.append(connection) }
        connection.start(queue: queue)
        receive(connection: connection, accumulated: Data())
    }

    private func receive(connection: NWConnection, accumulated: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let error {
                self.respondAndClose(connection, status: 500, body: "internal error")
                self.finish(.failure(.transport(error.localizedDescription)))
                return
            }
            var buffer = accumulated
            if let data { buffer.append(data) }

            // Wait for end of HTTP headers.
            if let separatorRange = buffer.range(of: Data([0x0D, 0x0A, 0x0D, 0x0A])) {
                let headerBytes = buffer.subdata(in: 0..<separatorRange.lowerBound)
                self.processRequest(connection: connection, headerBytes: headerBytes)
                return
            }

            // Cap buffer growth so a slowloris peer can't pin memory until the
            // 5-minute timeout fires.
            if buffer.count > Self.maxHeaderBytes {
                self.respondAndClose(connection, status: 431, body: "request header fields too large")
                self.finish(.failure(.transport("headers exceed \(Self.maxHeaderBytes) bytes")))
                return
            }

            if isComplete {
                self.respondAndClose(connection, status: 400, body: "bad request")
                self.finish(.failure(.transport("connection closed before headers complete")))
                return
            }

            self.receive(connection: connection, accumulated: buffer)
        }
    }

    private func processRequest(connection: NWConnection, headerBytes: Data) {
        guard let headerString = String(data: headerBytes, encoding: .utf8) else {
            respondAndClose(connection, status: 400, body: "invalid utf8 in request")
            finish(.failure(.transport("invalid utf8 in request line")))
            return
        }

        guard let firstLine = headerString.split(separator: "\r\n").first else {
            respondAndClose(connection, status: 400, body: "missing request line")
            finish(.failure(.transport("missing request line")))
            return
        }

        // GET /auth/callback?... HTTP/1.1
        let parts = firstLine.split(separator: " ")
        guard parts.count >= 2,
              let target = parts.dropFirst().first else {
            respondAndClose(connection, status: 400, body: "malformed request line")
            finish(.failure(.transport("malformed request line")))
            return
        }

        guard let urlComponents = URLComponents(string: "http://localhost\(target)") else {
            respondAndClose(connection, status: 400, body: "malformed request URI")
            finish(.failure(.transport("malformed request URI")))
            return
        }

        let query = urlComponents.queryItems ?? []
        let valueFor: (String) -> String? = { name in
            query.first { $0.name == name }?.value
        }

        if let oauthError = valueFor("error") {
            let description = valueFor("error_description") ?? oauthError
            respondAndClose(connection, status: 400, body: errorPage(description))
            finish(.failure(.oauthError(description)))
            return
        }

        guard let returnedState = valueFor("state"), returnedState == expectedState else {
            respondAndClose(connection, status: 400, body: errorPage("state mismatch"))
            finish(.failure(.stateMismatch))
            return
        }

        guard let code = valueFor("code"), !code.isEmpty else {
            respondAndClose(connection, status: 400, body: errorPage("missing authorization code"))
            finish(.failure(.missingCode))
            return
        }

        respondAndClose(connection, status: 200, body: successPage())
        finish(.success(code))
    }

    private func respondAndClose(_ connection: NWConnection, status: Int, body: String) {
        let statusText: String
        switch status {
        case 200: statusText = "OK"
        case 400: statusText = "Bad Request"
        default: statusText = "Internal Server Error"
        }
        let response = "HTTP/1.1 \(status) \(statusText)\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)"
        connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private func finish(_ result: Result<String, CodexOAuthLoopbackError>) {
        let pending: CheckedContinuation<String, Error>?
        lock.lock()
        if didFinish {
            lock.unlock()
            return
        }
        didFinish = true
        pending = continuation
        continuation = nil
        let listener = self.listener
        self.listener = nil
        let openConnections = connections
        connections = []
        lock.unlock()

        listener?.cancel()
        for connection in openConnections {
            connection.cancel()
        }

        // If the listener never reached .ready before this teardown, drain
        // the bind continuation so startListening() doesn't dangle.
        switch result {
        case .success: resumeReady(.success(()))
        case .failure(let err): resumeReady(.failure(err))
        }

        switch result {
        case .success(let code):
            pending?.resume(returning: code)
        case .failure(let err):
            pending?.resume(throwing: err)
        }
    }

    private func mapBindError(_ error: Error) -> CodexOAuthLoopbackError {
        let nsErr = error as NSError
        if let nwErr = error as? NWError {
            switch nwErr {
            case .posix(let code) where code == .EADDRINUSE:
                return .portInUse
            default:
                return .transport(nwErr.debugDescription)
            }
        }
        if nsErr.domain == NSPOSIXErrorDomain && nsErr.code == Int(EADDRINUSE) {
            return .portInUse
        }
        return .transport(error.localizedDescription)
    }

    private func successPage() -> String {
        """
        <!doctype html><meta charset="utf-8"><title>Sign-in complete</title>
        <style>body{font-family:-apple-system,system-ui,sans-serif;max-width:420px;margin:80px auto;padding:0 24px;text-align:center;color:#222}h1{font-weight:600}p{color:#555}</style>
        <h1>Signed in</h1>
        <p>You can close this tab and return to Vellum.</p>
        """
    }

    private func errorPage(_ message: String) -> String {
        let escaped = message
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        return """
        <!doctype html><meta charset="utf-8"><title>Sign-in failed</title>
        <style>body{font-family:-apple-system,system-ui,sans-serif;max-width:420px;margin:80px auto;padding:0 24px;text-align:center;color:#222}h1{font-weight:600;color:#b00}p{color:#555}</style>
        <h1>Sign-in failed</h1>
        <p>\(escaped)</p>
        <p>Return to Vellum and try again.</p>
        """
    }
}
