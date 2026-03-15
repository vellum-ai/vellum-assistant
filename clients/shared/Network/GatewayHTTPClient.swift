import Foundation

/// Authenticated HTTP client for gateway and platform proxy requests.
///
/// Consolidates URL construction, auth headers, org-id injection, and
/// request execution so callers can simply write:
///
///     let response = try await GatewayHTTPClient.get(path: "assistants/\(id)/healthz")
///     let response = try await GatewayHTTPClient.post(path: "assistants/upgrade")
@MainActor
public enum GatewayHTTPClient {

    /// Response from a gateway HTTP request.
    public struct Response {
        public let data: Data
        public let statusCode: Int

        public var isSuccess: Bool { (200..<300).contains(statusCode) }
    }

    /// Errors specific to gateway request construction.
    public enum ClientError: LocalizedError {
        case noConnectedAssistant
        case notAuthenticated
        case invalidURL

        public var errorDescription: String? {
            switch self {
            case .noConnectedAssistant: return "No connected assistant"
            case .notAuthenticated: return "Not authenticated"
            case .invalidURL: return "Invalid request URL"
            }
        }
    }

    // MARK: - High-Level API

    /// Performs an authenticated GET request against the gateway.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/` (e.g. `"assistants/{id}/healthz"`).
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    /// - Returns: A `Response` with the raw data and HTTP status code.
    /// - Throws: `ClientError` if the request cannot be constructed, or network errors from `URLSession`.
    public static func get(path: String, timeout: TimeInterval = 30) async throws -> Response {
        let request = try buildRequest(path: path, method: "GET", timeout: timeout)
        return try await execute(request)
    }

    /// Performs an authenticated POST request against the gateway.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/` (e.g. `"assistants/upgrade"`).
    ///   - body: Optional HTTP body data.
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    /// - Returns: A `Response` with the raw data and HTTP status code.
    /// - Throws: `ClientError` if the request cannot be constructed, or network errors from `URLSession`.
    public static func post(path: String, body: Data? = nil, timeout: TimeInterval = 30) async throws -> Response {
        var request = try buildRequest(path: path, method: "POST", timeout: timeout)
        request.httpBody = body
        return try await execute(request)
    }

    /// Performs an authenticated POST with a binary body (`application/octet-stream`).
    ///
    /// Use this instead of `post(path:body:timeout:)` when the payload is raw
    /// binary data (e.g. `.vbundle` archives) rather than JSON.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/` (e.g. `"assistants/{id}/transfer"`).
    ///   - body: Raw binary data to upload.
    ///   - timeout: Request timeout in seconds. Defaults to 120 to accommodate large bundle uploads.
    /// - Returns: A `Response` with the raw data and HTTP status code.
    /// - Throws: `ClientError` if the request cannot be constructed, or network errors from `URLSession`.
    public static func postBinary(path: String, body: Data, timeout: TimeInterval = 120) async throws -> Response {
        var request = try buildRequest(path: path, method: "POST", timeout: timeout)
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        return try await execute(request)
    }

    /// Performs an authenticated DELETE request against the gateway.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/` (e.g. `"assistants/{id}/secrets"`).
    ///   - body: Optional HTTP body data.
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    /// - Returns: A `Response` with the raw data and HTTP status code.
    /// - Throws: `ClientError` if the request cannot be constructed, or network errors from `URLSession`.
    public static func delete(path: String, body: Data? = nil, timeout: TimeInterval = 30) async throws -> Response {
        var request = try buildRequest(path: path, method: "DELETE", timeout: timeout)
        request.httpBody = body
        return try await execute(request)
    }

    /// Performs an authenticated streaming GET request against the gateway.
    ///
    /// Returns an async byte stream suitable for SSE or other streaming transports
    /// that need `URLSession.bytes(for:)` instead of `URLSession.data(for:)`.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/`.
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    /// - Returns: A tuple of `(URLSession.AsyncBytes, URLResponse)` for streaming consumption.
    /// - Throws: `ClientError` if the request cannot be constructed, or network errors from `URLSession`.
    public static func stream(path: String, timeout: TimeInterval = 30) async throws -> (URLSession.AsyncBytes, URLResponse) {
        var request = try buildRequest(path: path, method: "GET", timeout: timeout)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        return try await URLSession.shared.bytes(for: request)
    }

    // MARK: - Internals

    #if os(macOS)
    /// Resolves the currently connected assistant from the lockfile.
    private static func resolveConnectedAssistant() -> LockfileAssistant? {
        guard let id = UserDefaults.standard.string(forKey: "connectedAssistantId"), !id.isEmpty else { return nil }
        return LockfileAssistant.loadByName(id)
    }
    #endif

    /// Builds an authenticated `URLRequest`, automatically resolving the
    /// connected assistant, gateway base URL, and auth credentials.
    ///
    /// - Managed (`cloud == "vellum"`): platform proxy URL with `X-Session-Token`
    /// - Remote non-managed (GCP/AWS): `runtimeUrl` with `Authorization: Bearer`
    /// - Local: `http://127.0.0.1:{gatewayPort}` with `Authorization: Bearer`
    private static func buildRequest(
        path: String,
        method: String,
        timeout: TimeInterval
    ) throws -> URLRequest {
        #if os(macOS)
        guard let assistant = resolveConnectedAssistant() else {
            throw ClientError.noConnectedAssistant
        }

        let baseURL: String
        let authHeader: (field: String, value: String)

        if assistant.isManaged {
            guard let token = SessionTokenManager.getToken(), !token.isEmpty else {
                throw ClientError.notAuthenticated
            }
            baseURL = assistant.runtimeUrl ?? AuthService.shared.baseURL
            authHeader = ("X-Session-Token", token)
        } else {
            guard let token = ActorTokenManager.getToken(), !token.isEmpty else {
                throw ClientError.notAuthenticated
            }
            if assistant.isRemote {
                guard let runtimeUrl = assistant.runtimeUrl else {
                    throw ClientError.invalidURL
                }
                baseURL = runtimeUrl
            } else {
                let port = assistant.gatewayPort ?? LockfilePaths.resolveGatewayPort(connectedAssistantId: assistant.assistantId)
                baseURL = "http://127.0.0.1:\(port)"
            }
            authHeader = ("Authorization", "Bearer \(token)")
        }

        let trailingSlash = path.hasSuffix("/") ? "" : "/"
        guard let url = URL(string: "\(baseURL)/v1/\(path)\(trailingSlash)") else {
            throw ClientError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(authHeader.value, forHTTPHeaderField: authHeader.field)

        if let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId"), !orgId.isEmpty {
            request.setValue(orgId, forHTTPHeaderField: "Vellum-Organization-Id")
        }

        return request
        #else
        throw ClientError.noConnectedAssistant
        #endif
    }

    /// Executes a `URLRequest` and wraps the result in a `Response`.
    private static func execute(_ request: URLRequest) async throws -> Response {
        let (data, response) = try await URLSession.shared.data(for: request)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
        return Response(data: data, statusCode: statusCode)
    }
}
