import Foundation
import VellumAssistantShared

/// Authenticated HTTP client for platform assistant proxy requests and
/// dual-mode daemon requests (managed via platform proxy, local via localhost).
///
/// **Managed-only** (platform proxy) operations:
///
///     let response = try await GatewayHTTPClient.get(path: "\(id)/healthz")
///     let response = try await GatewayHTTPClient.post(path: "upgrade")
///
/// **Daemon** (managed + local) operations:
///
///     let response = try await GatewayHTTPClient.daemonGet(path: "v1/secrets")
///     let response = try await GatewayHTTPClient.daemonPost(path: "v1/secrets", body: data)
@MainActor
enum GatewayHTTPClient {

    /// Response from a gateway HTTP request.
    struct Response {
        let data: Data
        let statusCode: Int

        var isSuccess: Bool { (200..<300).contains(statusCode) }
    }

    /// Errors specific to gateway request construction.
    enum ClientError: LocalizedError {
        case noConnectedAssistant
        case notAuthenticated
        case invalidURL

        var errorDescription: String? {
            switch self {
            case .noConnectedAssistant: return "No connected assistant"
            case .notAuthenticated: return "Not authenticated"
            case .invalidURL: return "Invalid request URL"
            }
        }
    }

    /// Resolved connection details for the currently connected managed assistant.
    struct ConnectionInfo {
        let assistant: LockfileAssistant
        let baseURL: String
        let token: String
        let organizationId: String?
    }

    // MARK: - Managed-Only API

    /// Performs an authenticated GET request against the platform assistant proxy.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/assistants/` (e.g. `"{id}/healthz"` or `"releases"`).
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    /// - Returns: A `Response` with the raw data and HTTP status code.
    /// - Throws: `ClientError` if the request cannot be constructed, or network errors from `URLSession`.
    static func get(path: String, timeout: TimeInterval = 30) async throws -> Response {
        let request = try buildRequest(path: path, method: "GET", timeout: timeout)
        return try await execute(request)
    }

    /// Performs an authenticated POST request against the platform assistant proxy.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/assistants/` (e.g. `"upgrade"` or `"backups"`).
    ///   - body: Optional HTTP body data.
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    /// - Returns: A `Response` with the raw data and HTTP status code.
    /// - Throws: `ClientError` if the request cannot be constructed, or network errors from `URLSession`.
    static func post(path: String, body: Data? = nil, timeout: TimeInterval = 30) async throws -> Response {
        var request = try buildRequest(path: path, method: "POST", timeout: timeout)
        request.httpBody = body
        return try await execute(request)
    }

    /// Performs an authenticated DELETE request against the platform assistant proxy.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/assistants/` (e.g. `"{id}/secrets"`).
    ///   - body: Optional HTTP body data.
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    /// - Returns: A `Response` with the raw data and HTTP status code.
    /// - Throws: `ClientError` if the request cannot be constructed, or network errors from `URLSession`.
    static func delete(path: String, body: Data? = nil, timeout: TimeInterval = 30) async throws -> Response {
        var request = try buildRequest(path: path, method: "DELETE", timeout: timeout)
        request.httpBody = body
        return try await execute(request)
    }

    /// Resolves the current connection details (assistant, base URL, token, org ID)
    /// without performing a request. Useful for callers that need auth values for
    /// their own connection setup (e.g. SSE streams).
    ///
    /// - Throws: `ClientError` if no assistant is connected or not authenticated.
    static func resolveConnectionInfo() throws -> ConnectionInfo {
        guard let assistant = resolveConnectedAssistant() else {
            throw ClientError.noConnectedAssistant
        }
        guard let token = SessionTokenManager.getToken(), !token.isEmpty else {
            throw ClientError.notAuthenticated
        }
        let baseURL = assistant.runtimeUrl ?? AuthService.shared.baseURL
        let organizationId = UserDefaults.standard.string(forKey: "connectedOrganizationId")
        return ConnectionInfo(
            assistant: assistant,
            baseURL: baseURL,
            token: token,
            organizationId: organizationId
        )
    }

    // MARK: - Daemon API (Managed + Local)

    /// Performs a GET against the daemon's runtime HTTP server, routing through
    /// the platform proxy for managed assistants or directly to localhost for
    /// local ones.
    ///
    /// - Parameters:
    ///   - path: Daemon endpoint path (e.g. `"v1/secrets"`, `"v1/integrations/slack/channel/config"`).
    ///   - timeout: Request timeout in seconds. Defaults to 5.
    /// - Returns: A `Response` with the raw data and HTTP status code.
    /// - Throws: `ClientError` if the request cannot be constructed, or network errors from `URLSession`.
    static func daemonGet(path: String, timeout: TimeInterval = 5) async throws -> Response {
        let request = try buildDaemonRequest(path: path, method: "GET", timeout: timeout)
        return try await execute(request)
    }

    /// Performs a POST against the daemon's runtime HTTP server, routing through
    /// the platform proxy for managed assistants or directly to localhost for
    /// local ones.
    ///
    /// - Parameters:
    ///   - path: Daemon endpoint path (e.g. `"v1/secrets"`).
    ///   - body: Optional HTTP body data.
    ///   - timeout: Request timeout in seconds. Defaults to 5.
    /// - Returns: A `Response` with the raw data and HTTP status code.
    /// - Throws: `ClientError` if the request cannot be constructed, or network errors from `URLSession`.
    static func daemonPost(path: String, body: Data? = nil, timeout: TimeInterval = 5) async throws -> Response {
        var request = try buildDaemonRequest(path: path, method: "POST", timeout: timeout)
        request.httpBody = body
        return try await execute(request)
    }

    /// Performs a DELETE against the daemon's runtime HTTP server, routing through
    /// the platform proxy for managed assistants or directly to localhost for
    /// local ones.
    ///
    /// - Parameters:
    ///   - path: Daemon endpoint path (e.g. `"v1/secrets"`).
    ///   - body: Optional HTTP body data.
    ///   - timeout: Request timeout in seconds. Defaults to 5.
    /// - Returns: A `Response` with the raw data and HTTP status code.
    /// - Throws: `ClientError` if the request cannot be constructed, or network errors from `URLSession`.
    static func daemonDelete(path: String, body: Data? = nil, timeout: TimeInterval = 5) async throws -> Response {
        var request = try buildDaemonRequest(path: path, method: "DELETE", timeout: timeout)
        request.httpBody = body
        return try await execute(request)
    }

    /// Whether the daemon HTTP endpoint is currently reachable (auth is available).
    /// Useful for pre-flight checks before dispatching fire-and-forget requests.
    static func isDaemonReachable() -> Bool {
        return (try? buildDaemonRequest(path: "v1/secrets", method: "GET")) != nil
    }

    // MARK: - Internals

    /// Resolves the currently connected assistant from the lockfile.
    private static func resolveConnectedAssistant() -> LockfileAssistant? {
        guard let id = UserDefaults.standard.string(forKey: "connectedAssistantId"), !id.isEmpty else { return nil }
        return LockfileAssistant.loadByName(id)
    }

    /// Builds an authenticated `URLRequest` for the platform assistant proxy,
    /// automatically resolving the connected assistant and auth credentials.
    private static func buildRequest(
        path: String,
        method: String,
        timeout: TimeInterval
    ) throws -> URLRequest {
        guard let assistant = resolveConnectedAssistant() else {
            throw ClientError.noConnectedAssistant
        }
        guard let token = SessionTokenManager.getToken(), !token.isEmpty else {
            throw ClientError.notAuthenticated
        }

        let baseURL = assistant.runtimeUrl ?? AuthService.shared.baseURL
        let trailingSlash = path.hasSuffix("/") ? "" : "/"
        guard let url = URL(string: "\(baseURL)/v1/assistants/\(path)\(trailingSlash)") else {
            throw ClientError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "X-Session-Token")

        if let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId"), !orgId.isEmpty {
            request.setValue(orgId, forHTTPHeaderField: "Vellum-Organization-Id")
        }

        return request
    }

    /// Builds an authenticated `URLRequest` targeting the daemon, routing through
    /// the platform proxy for managed assistants or directly to localhost for
    /// local ones.
    ///
    /// - Managed: `{baseURL}/v1/assistants/{id}/{path}/` with `X-Session-Token`
    /// - Local: `http://localhost:{port}/{path}` with `Authorization: Bearer {jwt}`
    private static func buildDaemonRequest(
        path: String,
        method: String,
        timeout: TimeInterval = 5
    ) throws -> URLRequest {
        let connectedId = UserDefaults.standard.string(forKey: "connectedAssistantId")
        let assistant = connectedId.flatMap { LockfileAssistant.loadByName($0) }

        if let assistant, assistant.isManaged {
            guard let token = SessionTokenManager.getToken(), !token.isEmpty else {
                throw ClientError.notAuthenticated
            }
            let baseURL = assistant.runtimeUrl ?? AuthService.shared.baseURL
            let proxyPath = path.hasPrefix("v1/") ? String(path.dropFirst(3)) : path
            let trailingSlash = proxyPath.hasSuffix("/") ? "" : "/"
            guard let url = URL(string: "\(baseURL)/v1/assistants/\(assistant.assistantId)/\(proxyPath)\(trailingSlash)") else {
                throw ClientError.invalidURL
            }
            var request = URLRequest(url: url)
            request.httpMethod = method
            request.timeoutInterval = timeout
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(token, forHTTPHeaderField: "X-Session-Token")
            if let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId"), !orgId.isEmpty {
                request.setValue(orgId, forHTTPHeaderField: "Vellum-Organization-Id")
            }
            return request
        }

        // Local mode: direct to daemon runtime HTTP server.
        let port = assistant?.daemonPort
            ?? Int(ProcessInfo.processInfo.environment["RUNTIME_HTTP_PORT"] ?? "")
            ?? 7821
        guard let token = ActorTokenManager.getToken(), !token.isEmpty else {
            throw ClientError.notAuthenticated
        }
        guard let url = URL(string: "http://localhost:\(port)/\(path)") else {
            throw ClientError.invalidURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }

    /// Executes a `URLRequest` and wraps the result in a `Response`.
    private static func execute(_ request: URLRequest) async throws -> Response {
        let (data, response) = try await URLSession.shared.data(for: request)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
        return Response(data: data, statusCode: statusCode)
    }
}
