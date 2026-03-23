import Foundation

/// Authenticated HTTP client for gateway and platform proxy requests.
///
/// Consolidates URL construction, auth headers, org-id injection, and
/// request execution so callers can simply write:
///
///     let response = try await GatewayHTTPClient.get(path: "health")
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
    ///   - path: Path segment after `/v1/` (e.g. `"health"`).
    ///   - params: Optional query parameters. Keys and values are percent-encoded
    ///     using a restricted character set that escapes `&`, `=`, `+`, and `#`.
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    /// - Returns: A `Response` with the raw data and HTTP status code.
    /// - Throws: `ClientError` if the request cannot be constructed, or network errors from `URLSession`.
    public static func get(path: String, params: [String: String]? = nil, timeout: TimeInterval = 30) async throws -> Response {
        return try await executeWithRetry(path: path, params: params, method: "GET", timeout: timeout)
    }

    /// Performs an authenticated GET request and decodes the JSON response into the given type.
    ///
    /// Both the decoded value and the raw `Response` are returned so callers can
    /// inspect status codes or error bodies alongside the typed result.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/` (e.g. `"usage/totals"`).
    ///   - params: Optional query parameters. Keys and values are percent-encoded
    ///     using a restricted character set that escapes `&`, `=`, `+`, and `#`.
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    ///   - configure: Optional closure to customise the `JSONDecoder` before decoding
    ///     (e.g. set `keyDecodingStrategy`).
    /// - Returns: A tuple of the decoded value (or `nil` when the HTTP status is
    ///   non-success or decoding fails) and the raw `Response`.
    /// - Throws: `ClientError` if the request cannot be constructed, or network
    ///   errors from `URLSession`.
    public static func get<T: Decodable>(
        path: String,
        params: [String: String]? = nil,
        timeout: TimeInterval = 30,
        configure: ((_ decoder: JSONDecoder) -> Void)? = nil
    ) async throws -> (T?, Response) {
        let response = try await get(path: path, params: params, timeout: timeout)
        guard response.isSuccess else { return (nil, response) }
        let decoder = JSONDecoder()
        configure?(decoder)
        let decoded = try? decoder.decode(T.self, from: response.data)
        return (decoded, response)
    }

    /// Performs an authenticated POST request against the gateway.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/` (e.g. `"assistants/upgrade"`).
    ///   - body: Optional HTTP body data.
    ///   - params: Optional query parameters. Keys and values are percent-encoded
    ///     using a restricted character set that escapes `&`, `=`, `+`, and `#`.
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    /// - Returns: A `Response` with the raw data and HTTP status code.
    /// - Throws: `ClientError` if the request cannot be constructed, or network errors from `URLSession`.
    public static func post(path: String, body: Data? = nil, params: [String: String]? = nil, timeout: TimeInterval = 30) async throws -> Response {
        return try await executeWithRetry(path: path, params: params, method: "POST", timeout: timeout) { request in
            request.httpBody = body
        }
    }

    /// Performs an authenticated POST request, serializing a JSON-compatible dictionary as the body.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/`.
    ///   - json: A JSON-serializable dictionary used as the request body.
    ///   - extraHeaders: Optional additional headers to include in the request.
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    /// - Returns: A `Response` with the raw data and HTTP status code.
    /// - Throws: `ClientError` if the request cannot be constructed, serialization errors, or network errors.
    public static func post(path: String, json: [String: Any], extraHeaders: [String: String]? = nil, timeout: TimeInterval = 30) async throws -> Response {
        let body = try JSONSerialization.data(withJSONObject: json)
        return try await executeWithRetry(path: path, method: "POST", timeout: timeout) { request in
            request.httpBody = body
            if let extraHeaders {
                for (key, value) in extraHeaders {
                    request.setValue(value, forHTTPHeaderField: key)
                }
            }
        }
    }

    /// Performs an authenticated PATCH request against the gateway.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/`.
    ///   - body: Optional HTTP body data.
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    /// - Returns: A `Response` with the raw data and HTTP status code.
    /// - Throws: `ClientError` if the request cannot be constructed, or network errors from `URLSession`.
    public static func patch(path: String, body: Data? = nil, timeout: TimeInterval = 30) async throws -> Response {
        return try await executeWithRetry(path: path, method: "PATCH", timeout: timeout) { request in
            request.httpBody = body
        }
    }

    /// Performs an authenticated PATCH request, serializing a JSON-compatible dictionary as the body.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/`.
    ///   - json: A JSON-serializable dictionary used as the request body.
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    /// - Returns: A `Response` with the raw data and HTTP status code.
    /// - Throws: `ClientError` if the request cannot be constructed, serialization errors, or network errors.
    public static func patch(path: String, json: [String: Any], timeout: TimeInterval = 30) async throws -> Response {
        let body = try JSONSerialization.data(withJSONObject: json)
        return try await patch(path: path, body: body, timeout: timeout)
    }

    /// Performs an authenticated PUT request against the gateway.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/`.
    ///   - body: Optional HTTP body data.
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    /// - Returns: A `Response` with the raw data and HTTP status code.
    /// - Throws: `ClientError` if the request cannot be constructed, or network errors from `URLSession`.
    public static func put(path: String, body: Data? = nil, timeout: TimeInterval = 30) async throws -> Response {
        return try await executeWithRetry(path: path, method: "PUT", timeout: timeout) { request in
            request.httpBody = body
        }
    }

    /// Performs an authenticated PUT request, serializing a JSON-compatible dictionary as the body.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/`.
    ///   - json: A JSON-serializable dictionary used as the request body.
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    /// - Returns: A `Response` with the raw data and HTTP status code.
    /// - Throws: `ClientError` if the request cannot be constructed, serialization errors, or network errors.
    public static func put(path: String, json: [String: Any], timeout: TimeInterval = 30) async throws -> Response {
        let body = try JSONSerialization.data(withJSONObject: json)
        return try await put(path: path, body: body, timeout: timeout)
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
        return try await executeWithRetry(path: path, method: "DELETE", timeout: timeout) { request in
            request.httpBody = body
        }
    }

    /// Performs an authenticated DELETE request, serializing a JSON-compatible dictionary as the body.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/`.
    ///   - json: A JSON-serializable dictionary used as the request body.
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    /// - Returns: A `Response` with the raw data and HTTP status code.
    /// - Throws: `ClientError` if the request cannot be constructed, serialization errors, or network errors.
    public static func delete(path: String, json: [String: Any], timeout: TimeInterval = 30) async throws -> Response {
        let body = try JSONSerialization.data(withJSONObject: json)
        return try await delete(path: path, body: body, timeout: timeout)
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
        let connection = try resolveConnection()
        var request = try buildRequest(path: path, params: nil, method: "GET", timeout: timeout, connection: connection)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        return try await URLSession.shared.bytes(for: request)
    }

    /// Performs an authenticated streaming POST request against the gateway.
    ///
    /// Returns an async byte stream suitable for SSE or other streaming transports
    /// that need `URLSession.bytes(for:)` instead of `URLSession.data(for:)`.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/`.
    ///   - body: Pre-serialized request body data.
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    /// - Returns: A tuple of `(URLSession.AsyncBytes, URLResponse)` for streaming consumption.
    /// - Throws: `ClientError` if the request cannot be constructed, or network errors from `URLSession`.
    public static func streamPost(path: String, body: Data, timeout: TimeInterval = 30) async throws -> (URLSession.AsyncBytes, URLResponse) {
        let connection = try resolveConnection()
        var request = try buildRequest(path: path, params: nil, method: "POST", timeout: timeout, connection: connection)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.httpBody = body
        return try await URLSession.shared.bytes(for: request)
    }

    /// Performs an authenticated streaming POST request with automatic 401 retry
    /// for non-managed (bearer token) connections.
    ///
    /// On a 401 response, drains the response stream, attempts to refresh
    /// credentials via `ActorCredentialRefresher`, and retries the request once
    /// with fresh auth headers.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/`.
    ///   - body: Pre-serialized request body data.
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    /// - Returns: A tuple of `(URLSession.AsyncBytes, URLResponse)` for streaming consumption.
    /// - Throws: `ClientError` if the request cannot be constructed,
    ///   `URLError(.userAuthenticationRequired)` if credential refresh fails,
    ///   or network errors from `URLSession`.
    public static func streamPostWithRetry(path: String, body: Data, timeout: TimeInterval = 30) async throws -> (URLSession.AsyncBytes, URLResponse) {
        let connection = try resolveConnection()
        var request = try buildRequest(path: path, params: nil, method: "POST", timeout: timeout, connection: connection)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.httpBody = body

        let (bytes, response) = try await URLSession.shared.bytes(for: request)

        guard let http = response as? HTTPURLResponse,
              http.statusCode == 401,
              !connection.isManaged else {
            return (bytes, response)
        }

        // Drain the 401 response body before attempting credential refresh.
        for try await _ in bytes {}

        guard await refreshBearerCredentials(connection: connection) else {
            throw URLError(.userAuthenticationRequired, userInfo: [
                NSLocalizedDescriptionKey: "Authentication failed — please try again."
            ])
        }

        // Rebuild with fresh credentials from the Keychain.
        let freshConnection = try resolveConnection()
        var retryRequest = try buildRequest(path: path, params: nil, method: "POST", timeout: timeout, connection: freshConnection)
        retryRequest.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        retryRequest.httpBody = body
        return try await URLSession.shared.bytes(for: retryRequest)
    }

    // MARK: - Internals

    #if os(macOS)
    /// Resolves the currently connected assistant from the lockfile.
    private static func resolveConnectedAssistant() -> LockfileAssistant? {
        guard let id = UserDefaults.standard.string(forKey: "connectedAssistantId"), !id.isEmpty else { return nil }
        return LockfileAssistant.loadByName(id)
    }
    #endif

    /// Resolved connection metadata used for request construction and auth retry.
    private struct ConnectionInfo {
        let baseURL: String
        let authHeader: (field: String, value: String)?
        /// The connected assistant's identifier, used to replace `{assistantId}`
        /// placeholders in request paths.
        let assistantId: String
        let isManaged: Bool
    }

    /// Resolves the base URL, auth header, assistant ID, and managed flag for the current connection.
    ///
    /// - macOS: Uses the lockfile-based `LockfileAssistant` for full resolution
    ///   (managed, remote, and local assistants).
    /// - iOS: Uses UserDefaults for managed assistants (`managed_assistant_id` +
    ///   `managed_platform_base_url`) and QR-paired assistants (`gateway_base_url`),
    ///   with tokens from the Keychain via `SessionTokenManager` / `ActorTokenManager`.
    private static func resolveConnection() throws -> ConnectionInfo {
        #if os(macOS)
        guard let assistant = resolveConnectedAssistant() else {
            throw ClientError.noConnectedAssistant
        }

        if assistant.isManaged {
            guard let token = SessionTokenManager.getToken(), !token.isEmpty else {
                throw ClientError.notAuthenticated
            }
            let baseURL = assistant.runtimeUrl ?? AuthService.shared.baseURL
            return ConnectionInfo(baseURL: baseURL, authHeader: ("X-Session-Token", token), assistantId: assistant.assistantId, isManaged: true)
        } else {
            let token = ActorTokenManager.getToken()
            let authHeader: (String, String)? = (token != nil && !token!.isEmpty)
                ? ("Authorization", "Bearer \(token!)")
                : nil
            if assistant.isRemote {
                guard let runtimeUrl = assistant.runtimeUrl else {
                    throw ClientError.invalidURL
                }
                return ConnectionInfo(baseURL: runtimeUrl, authHeader: authHeader, assistantId: assistant.assistantId, isManaged: false)
            } else {
                let port = assistant.gatewayPort ?? LockfilePaths.resolveGatewayPort(connectedAssistantId: assistant.assistantId)
                return ConnectionInfo(baseURL: "http://127.0.0.1:\(port)", authHeader: authHeader, assistantId: assistant.assistantId, isManaged: false)
            }
        }

        #elseif os(iOS)
        // Managed assistant: cloud-hosted via platform proxy with session token auth.
        if let managedAssistantId = UserDefaults.standard.string(forKey: "managed_assistant_id"),
           !managedAssistantId.isEmpty,
           let platformBaseURL = UserDefaults.standard.string(forKey: "managed_platform_base_url"),
           !platformBaseURL.isEmpty {
            guard let token = SessionTokenManager.getToken(), !token.isEmpty else {
                throw ClientError.notAuthenticated
            }
            return ConnectionInfo(baseURL: platformBaseURL, authHeader: ("X-Session-Token", token), assistantId: managedAssistantId, isManaged: true)
        }

        // QR-paired assistant: gateway URL with bearer token auth.
        if let gatewayBaseURL = UserDefaults.standard.string(forKey: "gateway_base_url"),
           !gatewayBaseURL.isEmpty {
            let token = ActorTokenManager.getToken()
            let authHeader: (String, String)? = (token != nil && !token!.isEmpty)
                ? ("Authorization", "Bearer \(token!)")
                : nil
            // QR-paired assistants don't carry an assistant ID in UserDefaults;
            // use an empty string so `{assistantId}` placeholders resolve harmlessly.
            return ConnectionInfo(baseURL: gatewayBaseURL, authHeader: authHeader, assistantId: "", isManaged: false)
        }

        throw ClientError.noConnectedAssistant
        #else
        throw ClientError.noConnectedAssistant
        #endif
    }

    /// A restricted character set for encoding query parameter values.
    /// `.urlQueryAllowed` permits `&`, `=`, `+`, and `#` which are
    /// query-string metacharacters. Values containing these characters
    /// would break parameter parsing, so we exclude them.
    private static let queryValueAllowed: CharacterSet = {
        var cs = CharacterSet.urlQueryAllowed
        cs.remove(charactersIn: "&=+#")
        return cs
    }()

    /// Returns `true` when the current connection targets a managed (cloud-hosted)
    /// assistant that routes through the platform proxy, `false` otherwise.
    ///
    /// Callers can use this to decide whether request paths need the
    /// `assistants/{assistantId}/` scope prefix (required by the platform) or
    /// should use flat paths (required by non-managed runtimes).
    public static func isConnectionManaged() throws -> Bool {
        return try resolveConnection().isManaged
    }

    /// Constructs a gateway URL for the given path and query parameters.
    ///
    /// Use this when you need a raw URL (e.g. for media viewers) rather than
    /// making a full HTTP request via ``get(path:params:timeout:)`` or
    /// ``post(path:body:timeout:)``.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/` (e.g. `"assistants/{assistantId}/workspace/file/content"`).
    ///   - params: Optional query parameters.
    /// - Returns: The fully-qualified URL with `{assistantId}` resolved.
    /// - Throws: `ClientError` if the connection cannot be resolved or the URL is invalid.
    public static func buildURL(path: String, params: [String: String]? = nil) throws -> URL {
        let connection = try resolveConnection()
        return try constructURL(path: path, params: params, connection: connection)
    }

    /// Builds the gateway URL from path, query parameters, and connection info.
    private static func constructURL(
        path: String,
        params: [String: String]?,
        connection: ConnectionInfo
    ) throws -> URL {
        var resolvedPath = path.replacingOccurrences(of: "{assistantId}", with: connection.assistantId)
        // QR-mode connections have an empty assistantId — collapse the empty scope
        // prefix so e.g. "assistants//trace-events" falls back to "trace-events".
        if connection.assistantId.isEmpty {
            resolvedPath = resolvedPath.replacingOccurrences(of: "assistants//", with: "")
        }

        let pathComponent: String
        let queryComponent: String
        if let queryIndex = resolvedPath.firstIndex(of: "?") {
            pathComponent = String(resolvedPath[..<queryIndex])
            queryComponent = String(resolvedPath[queryIndex...])
        } else {
            pathComponent = resolvedPath
            queryComponent = ""
        }

        var queryString = queryComponent
        if let params, !params.isEmpty {
            let encodedPairs = params.sorted(by: { $0.key < $1.key }).compactMap { key, value -> String? in
                guard let encodedValue = value.addingPercentEncoding(withAllowedCharacters: Self.queryValueAllowed) else { return nil }
                return "\(key)=\(encodedValue)"
            }
            if !encodedPairs.isEmpty {
                let joined = encodedPairs.joined(separator: "&")
                queryString = queryString.isEmpty ? "?\(joined)" : "\(queryString)&\(joined)"
            }
        }

        let encodedPath = pathComponent.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? pathComponent
        let trailingSlash = encodedPath.hasSuffix("/") ? "" : "/"
        guard let url = URL(string: "\(connection.baseURL)/v1/\(encodedPath)\(trailingSlash)\(queryString)") else {
            throw ClientError.invalidURL
        }
        return url
    }

    /// Builds an authenticated `URLRequest` from the given connection info.
    private static func buildRequest(
        path: String,
        params: [String: String]?,
        method: String,
        timeout: TimeInterval,
        connection: ConnectionInfo
    ) throws -> URLRequest {
        let url = try constructURL(path: path, params: params, connection: connection)

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let authHeader = connection.authHeader {
            request.setValue(authHeader.value, forHTTPHeaderField: authHeader.field)
        }

        if let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId"), !orgId.isEmpty {
            request.setValue(orgId, forHTTPHeaderField: "Vellum-Organization-Id")
        }

        return request
    }

    /// Executes a `URLRequest` and wraps the result in a `Response`.
    private static func execute(_ request: URLRequest) async throws -> Response {
        let (data, response) = try await URLSession.shared.data(for: request)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
        return Response(data: data, statusCode: statusCode)
    }

    // MARK: - Auth Retry

    /// Executes a request with automatic 401 retry for non-managed (bearer token) connections.
    /// On a 401 response, attempts to refresh credentials via `ActorCredentialRefresher`
    /// and retries the request once with fresh auth headers.
    private static func executeWithRetry(
        path: String,
        params: [String: String]? = nil,
        method: String,
        timeout: TimeInterval,
        configure: ((_ request: inout URLRequest) -> Void)? = nil
    ) async throws -> Response {
        let connection = try resolveConnection()
        var request = try buildRequest(path: path, params: params, method: method, timeout: timeout, connection: connection)
        configure?(&request)
        let response = try await execute(request)

        guard response.statusCode == 401, !connection.isManaged else {
            return response
        }

        guard await refreshBearerCredentials(connection: connection) else {
            return response
        }

        // Rebuild with fresh credentials from the Keychain.
        let freshConnection = try resolveConnection()
        var retryRequest = try buildRequest(path: path, params: params, method: method, timeout: timeout, connection: freshConnection)
        configure?(&retryRequest)
        return try await execute(retryRequest)
    }

    /// Attempts a bearer-token credential refresh.
    /// Returns `true` when the refresh succeeds and the request should be retried.
    private static func refreshBearerCredentials(connection: ConnectionInfo) async -> Bool {
        #if os(macOS)
        let platform = "macos"
        let deviceId = computeMacOSDeviceId()
        #elseif os(iOS)
        let platform = "ios"
        let deviceId = APIKeyManager.shared.getAPIKey(provider: "pairing-device-id") ?? ""
        #else
        return false
        #endif

        let result = await ActorCredentialRefresher.refresh(
            platform: platform,
            deviceId: deviceId
        )
        if case .success = result { return true }
        return false
    }

    // MARK: - macOS Device ID

    #if os(macOS)
    /// Compute a stable device ID from the IOPlatformUUID.
    /// Delegates to the shared `HostIdComputer` implementation.
    private static func computeMacOSDeviceId() -> String {
        return HostIdComputer.computeHostId()
    }
    #endif
}
