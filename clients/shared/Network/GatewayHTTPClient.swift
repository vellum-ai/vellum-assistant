import Foundation
#if os(macOS)
import CryptoKit
import IOKit
#endif

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
        return try await executeWithRetry(path: path, method: "GET", timeout: timeout)
    }

    /// Performs an authenticated GET request and decodes the JSON response into the given type.
    ///
    /// Both the decoded value and the raw `Response` are returned so callers can
    /// inspect status codes or error bodies alongside the typed result.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/` (e.g. `"usage/totals?from=0&to=1"`).
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    ///   - configure: Optional closure to customise the `JSONDecoder` before decoding
    ///     (e.g. set `keyDecodingStrategy`).
    /// - Returns: A tuple of the decoded value (or `nil` when the HTTP status is
    ///   non-success or decoding fails) and the raw `Response`.
    /// - Throws: `ClientError` if the request cannot be constructed, or network
    ///   errors from `URLSession`.
    public static func get<T: Decodable>(
        path: String,
        timeout: TimeInterval = 30,
        configure: ((_ decoder: JSONDecoder) -> Void)? = nil
    ) async throws -> (T?, Response) {
        let response = try await get(path: path, timeout: timeout)
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
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    /// - Returns: A `Response` with the raw data and HTTP status code.
    /// - Throws: `ClientError` if the request cannot be constructed, or network errors from `URLSession`.
    public static func post(path: String, body: Data? = nil, timeout: TimeInterval = 30) async throws -> Response {
        return try await executeWithRetry(path: path, method: "POST", timeout: timeout) { request in
            request.httpBody = body
        }
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
        var request = try buildRequest(path: path, method: "GET", timeout: timeout, connection: connection)
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

    /// Resolved connection metadata used for request construction and auth retry.
    struct ConnectionInfo {
        let baseURL: String
        let authHeader: (field: String, value: String)
        /// Non-nil when the connection targets a platform-managed assistant.
        /// Callers that need platform-proxy routing can use this to prepend
        /// `assistants/{id}/` to their path.
        let managedAssistantId: String?

        var isManaged: Bool { managedAssistantId != nil }
    }

    /// Resolves the base URL, auth header, and managed assistant ID for the current connection.
    ///
    /// - macOS: Uses the lockfile-based `LockfileAssistant` for full resolution
    ///   (managed, remote, and local assistants).
    /// - iOS: Uses UserDefaults for managed assistants (`managed_assistant_id` +
    ///   `managed_platform_base_url`) and QR-paired assistants (`gateway_base_url`),
    ///   with tokens from the Keychain via `SessionTokenManager` / `ActorTokenManager`.
    static func resolveConnection() throws -> ConnectionInfo {
        #if os(macOS)
        guard let assistant = resolveConnectedAssistant() else {
            throw ClientError.noConnectedAssistant
        }

        if assistant.isManaged {
            guard let token = SessionTokenManager.getToken(), !token.isEmpty else {
                throw ClientError.notAuthenticated
            }
            let baseURL = assistant.runtimeUrl ?? AuthService.shared.baseURL
            return ConnectionInfo(baseURL: baseURL, authHeader: ("X-Session-Token", token), managedAssistantId: assistant.assistantId)
        } else {
            guard let token = ActorTokenManager.getToken(), !token.isEmpty else {
                throw ClientError.notAuthenticated
            }
            if assistant.isRemote {
                guard let runtimeUrl = assistant.runtimeUrl else {
                    throw ClientError.invalidURL
                }
                return ConnectionInfo(baseURL: runtimeUrl, authHeader: ("Authorization", "Bearer \(token)"), managedAssistantId: nil)
            } else {
                let port = assistant.gatewayPort ?? LockfilePaths.resolveGatewayPort(connectedAssistantId: assistant.assistantId)
                return ConnectionInfo(baseURL: "http://127.0.0.1:\(port)", authHeader: ("Authorization", "Bearer \(token)"), managedAssistantId: nil)
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
            return ConnectionInfo(baseURL: platformBaseURL, authHeader: ("X-Session-Token", token), managedAssistantId: managedAssistantId)
        }

        // QR-paired assistant: gateway URL with bearer token auth.
        if let gatewayBaseURL = UserDefaults.standard.string(forKey: "gateway_base_url"),
           !gatewayBaseURL.isEmpty {
            guard let token = ActorTokenManager.getToken(), !token.isEmpty else {
                throw ClientError.notAuthenticated
            }
            return ConnectionInfo(baseURL: gatewayBaseURL, authHeader: ("Authorization", "Bearer \(token)"), managedAssistantId: nil)
        }

        throw ClientError.noConnectedAssistant
        #else
        throw ClientError.noConnectedAssistant
        #endif
    }

    /// Builds an authenticated `URLRequest` from the given connection info.
    ///
    /// The caller is responsible for including any assistant-scoped prefix
    /// (e.g. `assistants/{id}/`) in the `path` when targeting managed connections.
    /// Use `ConnectionInfo.managedAssistantId` to determine if a prefix is needed.
    private static func buildRequest(
        path: String,
        method: String,
        timeout: TimeInterval,
        connection: ConnectionInfo
    ) throws -> URLRequest {
        let pathComponent: String
        let queryComponent: String
        if let queryIndex = path.firstIndex(of: "?") {
            pathComponent = String(path[..<queryIndex])
            queryComponent = String(path[queryIndex...])
        } else {
            pathComponent = path
            queryComponent = ""
        }

        let trailingSlash = pathComponent.hasSuffix("/") ? "" : "/"
        guard let url = URL(string: "\(connection.baseURL)/v1/\(pathComponent)\(trailingSlash)\(queryComponent)") else {
            throw ClientError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(connection.authHeader.value, forHTTPHeaderField: connection.authHeader.field)

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
        method: String,
        timeout: TimeInterval,
        configure: ((_ request: inout URLRequest) -> Void)? = nil
    ) async throws -> Response {
        let connection = try resolveConnection()
        var request = try buildRequest(path: path, method: method, timeout: timeout, connection: connection)
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
        var retryRequest = try buildRequest(path: path, method: method, timeout: timeout, connection: freshConnection)
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
            baseURL: connection.baseURL,
            bearerToken: ActorTokenManager.getToken(),
            platform: platform,
            deviceId: deviceId
        )
        if case .success = result { return true }
        return false
    }

    // MARK: - macOS Device ID

    #if os(macOS)
    /// Compute a stable device ID from the IOPlatformUUID.
    private static func computeMacOSDeviceId() -> String {
        let platformUUID = getMacOSPlatformUUID() ?? UUID().uuidString
        let salt = "vellum-assistant-host-id"
        let input = Data((platformUUID + salt).utf8)
        let hash = SHA256.hash(data: input)
        return hash.compactMap { String(format: "%02x", $0) }.joined()
    }

    /// Read the IOPlatformUUID from the IORegistry (macOS hardware identifier).
    private static func getMacOSPlatformUUID() -> String? {
        let service = IOServiceGetMatchingService(
            kIOMainPortDefault,
            IOServiceMatching("IOPlatformExpertDevice")
        )
        guard service != 0 else { return nil }
        defer { IOObjectRelease(service) }

        let key = kIOPlatformUUIDKey as CFString
        guard let uuid = IORegistryEntryCreateCFProperty(service, key, kCFAllocatorDefault, 0)?
            .takeRetainedValue() as? String else {
            return nil
        }
        return uuid
    }
    #endif
}
