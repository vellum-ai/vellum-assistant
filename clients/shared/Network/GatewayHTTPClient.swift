import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "GatewayHTTPClient")

/// Represents a single part in a multipart/form-data request.
public enum MultipartPart {
    case text(name: String, value: String)
    case file(name: String, filename: String, mimeType: String, data: Data)
}

/// Authenticated HTTP client for gateway and platform proxy requests.
///
/// Consolidates URL construction, auth headers, org-id injection, and
/// request execution so callers can simply write:
///
///     let response = try await GatewayHTTPClient.get(path: "health")
///     let response = try await GatewayHTTPClient.post(path: "assistants/upgrade")
public enum GatewayHTTPClient {
    private static let sseAcceptHeader = "text/event-stream, application/json"

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
    ///   - quiet: When `true`, suppresses HTTP request/response logging for this request.
    /// - Returns: A `Response` with the raw data and HTTP status code.
    /// - Throws: `ClientError` if the request cannot be constructed, or network errors from `URLSession`.
    public static func get(path: String, params: [String: String]? = nil, timeout: TimeInterval = 30, quiet: Bool = false) async throws -> Response {
        return try await executeWithRetry(path: path, params: params, method: "GET", timeout: timeout, quiet: quiet)
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
    public static func post(path: String, body: Data? = nil, params: [String: String]? = nil, contentType: String? = nil, timeout: TimeInterval = 30) async throws -> Response {
        return try await executeWithRetry(path: path, params: params, method: "POST", timeout: timeout) { request in
            request.httpBody = body
            if let contentType {
                request.setValue(contentType, forHTTPHeaderField: "Content-Type")
            }
        }
    }

    /// Performs an authenticated POST request, serializing a JSON-compatible dictionary as the body.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/`.
    ///   - json: A JSON-serializable dictionary used as the request body.
    ///   - extraHeaders: Optional additional headers to include in the request.
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    ///   - skipRetry: When `true`, bypasses the 401 retry interceptor. Use this for
    ///     the credential refresh endpoint to prevent recursive refresh loops.
    /// - Returns: A `Response` with the raw data and HTTP status code.
    /// - Throws: `ClientError` if the request cannot be constructed, serialization errors, or network errors.
    public static func post(path: String, json: [String: Any], extraHeaders: [String: String]? = nil, timeout: TimeInterval = 30, skipRetry: Bool = false) async throws -> Response {
        let body = try JSONSerialization.data(withJSONObject: json)
        return try await executeWithRetry(path: path, method: "POST", timeout: timeout, skipRetry: skipRetry) { request in
            request.httpBody = body
            if let extraHeaders {
                for (key, value) in extraHeaders {
                    request.setValue(value, forHTTPHeaderField: key)
                }
            }
        }
    }

    /// Performs an authenticated POST request with a `multipart/form-data` body.
    ///
    /// Constructs the multipart body from an array of ``MultipartPart`` values
    /// (text fields and binary file parts), generates a UUID-based boundary,
    /// and uses the standard `buildRequest()` pipeline for auth headers and URL
    /// resolution.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/`.
    ///   - parts: The multipart form-data parts to include in the request body.
    ///   - timeout: Request timeout in seconds. Defaults to 60.
    /// - Returns: A `Response` with the raw data and HTTP status code.
    /// - Throws: `ClientError` if the request cannot be constructed, or network errors from `URLSession`.
    public static func postMultipart(path: String, parts: [MultipartPart], timeout: TimeInterval = 60) async throws -> Response {
        let boundary = UUID().uuidString
        var body = Data()

        for part in parts {
            switch part {
            case .text(let name, let value):
                body.append("--\(boundary)\r\n".data(using: .utf8)!)
                body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".data(using: .utf8)!)
                body.append("\(value)\r\n".data(using: .utf8)!)
            case .file(let name, let filename, let mimeType, let data):
                let sanitizedFilename = filename
                    .replacingOccurrences(of: "\"", with: "_")
                    .replacingOccurrences(of: "\r", with: "_")
                    .replacingOccurrences(of: "\n", with: "_")
                body.append("--\(boundary)\r\n".data(using: .utf8)!)
                body.append("Content-Disposition: form-data; name=\"\(name)\"; filename=\"\(sanitizedFilename)\"\r\n".data(using: .utf8)!)
                body.append("Content-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
                body.append(data)
                body.append("\r\n".data(using: .utf8)!)
            }
        }

        body.append("--\(boundary)--\r\n".data(using: .utf8)!)

        return try await executeWithRetry(path: path, method: "POST", timeout: timeout) { request in
            request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
    }

    /// Performs an authenticated POST request that streams the response and
    /// reports download progress via an `onProgress` callback.
    ///
    /// Uses a custom `URLSessionDataDelegate` to receive the response body in
    /// network-sized chunks and track progress. When the server provides a
    /// `Content-Length` header, `onProgress` is called on the main actor with
    /// a value between 0.0 and 1.0 representing `bytesReceived / totalBytes`.
    /// When `Content-Length` is absent (e.g. chunked transfer encoding),
    /// `onProgress` is called once with `-1` to signal indeterminate progress.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/`.
    ///   - body: Optional HTTP body data.
    ///   - params: Optional query parameters.
    ///   - contentType: Optional Content-Type header value.
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    ///   - onProgress: Closure called on the main actor with the current
    ///     download fraction (0.0–1.0), or `-1` for indeterminate.
    /// - Returns: A `Response` with the raw data and HTTP status code.
    /// - Throws: `ClientError` if the request cannot be constructed, or network errors from `URLSession`.
    public static func post(
        path: String,
        body: Data? = nil,
        params: [String: String]? = nil,
        contentType: String? = nil,
        timeout: TimeInterval = 30,
        onProgress: @escaping @MainActor (Double) -> Void
    ) async throws -> Response {
        let connection = try resolveConnection()
        var request = try buildRequest(path: path, params: params, method: "POST", timeout: timeout, connection: connection)
        request.httpBody = body
        if let contentType {
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        logOutgoing(request, quiet: false)

        let (result, _) = try await performStreamingPost(request: request, onProgress: onProgress)

        // 401 retry for non-managed (bearer token) connections.
        if result.statusCode == 401, !connection.isManaged {
            if await refreshBearerCredentials(connection: connection) {
                let freshConnection = try resolveConnection()
                var retryRequest = try buildRequest(path: path, params: params, method: "POST", timeout: timeout, connection: freshConnection)
                retryRequest.httpBody = body
                if let contentType {
                    retryRequest.setValue(contentType, forHTTPHeaderField: "Content-Type")
                }
                logOutgoing(retryRequest, quiet: false)

                let (retryResult, _) = try await performStreamingPost(request: retryRequest, onProgress: onProgress)
                return retryResult
            }

            // Refresh failed — return the original 401 response.
            return result
        }

        return result
    }

    /// Performs a POST request with progress tracking using a delegate-based data task
    /// that receives data in chunks (not byte-by-byte).
    private static func performStreamingPost(
        request: URLRequest,
        onProgress: @escaping @MainActor (Double) -> Void
    ) async throws -> (Response, HTTPURLResponse?) {
        let delegate = DownloadProgressDelegate(onProgress: onProgress)
        let session = URLSession(configuration: .default, delegate: delegate, delegateQueue: nil)
        defer {
            delegate.invalidate()
            session.finishTasksAndInvalidate()
        }

        let (data, response) = try await session.data(for: request, delegate: delegate)
        let http = response as? HTTPURLResponse
        let statusCode = http?.statusCode ?? -1

        if let http {
            logResponse(request, http: http, quiet: false)
        }

        // Send final progress if we tracked determinately.
        if delegate.totalBytes > 0, delegate.lastReportedFraction < 1.0 {
            await MainActor.run { onProgress(1.0) }
        }

        return (Response(data: data, statusCode: statusCode), http)
    }

    /// URLSessionDataDelegate that tracks download progress via `didReceive data:` chunks.
    /// Uses a generation counter to prevent stale callbacks from firing after invalidation.
    private class DownloadProgressDelegate: NSObject, URLSessionDataDelegate {
        let onProgress: @MainActor (Double) -> Void
        var totalBytes: Int64 = -1
        var receivedBytes: Int64 = 0
        var lastReportedFraction: Double = 0.0
        private var reportedIndeterminate = false
        private var generation: Int = 0
        private var invalidated = false

        init(onProgress: @escaping @MainActor (Double) -> Void) {
            self.onProgress = onProgress
        }

        /// Prevents any further progress callbacks from being dispatched.
        func invalidate() {
            invalidated = true
            generation += 1
        }

        func urlSession(
            _ session: URLSession,
            dataTask: URLSessionDataTask,
            didReceive response: URLResponse,
            completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
        ) {
            totalBytes = response.expectedContentLength // -1 when unknown
            if totalBytes <= 0, !reportedIndeterminate, !invalidated {
                reportedIndeterminate = true
                let callback = self.onProgress
                let gen = self.generation
                Task { [weak self] in
                    guard self?.generation == gen else { return }
                    await callback(-1)
                }
            }
            completionHandler(.allow)
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            receivedBytes += Int64(data.count)
            guard totalBytes > 0, !invalidated else { return }
            let fraction = Double(receivedBytes) / Double(totalBytes)
            guard fraction - lastReportedFraction >= 0.01 || receivedBytes >= totalBytes else { return }
            lastReportedFraction = fraction
            let callback = self.onProgress
            let gen = self.generation
            Task { [weak self] in
                guard self?.generation == gen else { return }
                await callback(min(fraction, 1.0))
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

    /// Result of an authenticated download-to-disk request.
    public struct DownloadResponse {
        /// Local temporary file URL where the response body was written.
        public let fileURL: URL
        public let statusCode: Int

        public var isSuccess: Bool { (200..<300).contains(statusCode) }
    }

    /// Performs an authenticated GET request that streams the response directly
    /// to a temporary file on disk, avoiding buffering the entire payload in memory.
    ///
    /// Use this instead of ``get(path:params:timeout:)`` for large binary payloads
    /// (e.g. video files) where in-memory buffering would cause memory pressure.
    ///
    /// Includes automatic 401 retry for non-managed (bearer token) connections,
    /// matching the behaviour of ``get(path:params:timeout:)``.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/`.
    ///   - params: Optional query parameters.
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    /// - Returns: A ``DownloadResponse`` with the local file URL and HTTP status code.
    /// - Throws: `ClientError` if the request cannot be constructed, or network errors from `URLSession`.
    public static func download(path: String, params: [String: String]? = nil, timeout: TimeInterval = 30) async throws -> DownloadResponse {
        let connection = try resolveConnection()
        let request = try buildRequest(path: path, params: params, method: "GET", timeout: timeout, connection: connection)
        let response = try await executeDownload(request)

        guard response.statusCode == 401, !connection.isManaged else {
            return response
        }

        guard await refreshBearerCredentials(connection: connection) else {
            return response
        }

        // Clean up the 401 download only after confirming we will retry.
        try? FileManager.default.removeItem(at: response.fileURL)

        let freshConnection = try resolveConnection()
        let retryRequest = try buildRequest(path: path, params: params, method: "GET", timeout: timeout, connection: freshConnection)
        return try await executeDownload(retryRequest)
    }

    /// Performs an authenticated streaming GET request against the gateway.
    ///
    /// Returns an async byte stream suitable for SSE or other streaming transports
    /// that need `URLSession.bytes(for:)` instead of `URLSession.data(for:)`.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/`.
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    ///   - session: The `URLSession` to use. Defaults to `.shared`. Pass a dedicated
    ///     session when the caller needs to control the lifecycle of the underlying
    ///     data task (e.g. to safely cancel an SSE stream without a use-after-free
    ///     in `AsyncBytes`).
    /// - Returns: A tuple of `(URLSession.AsyncBytes, URLResponse)` for streaming consumption.
    /// - Throws: `ClientError` if the request cannot be constructed, or network errors from `URLSession`.
    public static func stream(path: String, timeout: TimeInterval = 30, session: URLSession = .shared) async throws -> (URLSession.AsyncBytes, URLResponse) {
        let connection = try resolveConnection()
        var request = try buildRequest(path: path, params: nil, method: "GET", timeout: timeout, connection: connection)
        request.setValue(sseAcceptHeader, forHTTPHeaderField: "Accept")
        logOutgoing(request, quiet: false)
        let (bytes, response) = try await session.bytes(for: request)
        if let http = response as? HTTPURLResponse {
            logResponse(request, http: http, quiet: false)
        }
        return (bytes, response)
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
    ///   - session: The `URLSession` to use. Defaults to `.shared`. Pass a dedicated
    ///     session when the caller needs to control the lifecycle of the underlying
    ///     data task (e.g. to safely cancel a stream without a use-after-free
    ///     in `AsyncBytes`).
    /// - Returns: A tuple of `(URLSession.AsyncBytes, URLResponse)` for streaming consumption.
    /// - Throws: `ClientError` if the request cannot be constructed, or network errors from `URLSession`.
    public static func streamPost(path: String, body: Data, timeout: TimeInterval = 30, session: URLSession = .shared) async throws -> (URLSession.AsyncBytes, URLResponse) {
        let connection = try resolveConnection()
        var request = try buildRequest(path: path, params: nil, method: "POST", timeout: timeout, connection: connection)
        request.setValue(sseAcceptHeader, forHTTPHeaderField: "Accept")
        request.httpBody = body
        logOutgoing(request, quiet: false)
        let (bytes, response) = try await session.bytes(for: request)
        if let http = response as? HTTPURLResponse {
            logResponse(request, http: http, quiet: false)
        }
        return (bytes, response)
    }

    /// Performs an authenticated streaming POST request with automatic 401 retry
    /// for non-managed (bearer token) connections.
    ///
    /// On a 401 response, drains the response stream, attempts to refresh
    /// credentials via `TokenRefreshCoordinator`, and retries the request once
    /// with fresh auth headers.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/`.
    ///   - body: Pre-serialized request body data.
    ///   - timeout: Request timeout in seconds. Defaults to 30.
    ///   - session: The `URLSession` to use. Defaults to `.shared`. Pass a dedicated
    ///     session when the caller needs to control the lifecycle of the underlying
    ///     data task (e.g. to safely cancel a stream without a use-after-free
    ///     in `AsyncBytes`).
    /// - Returns: A tuple of `(URLSession.AsyncBytes, URLResponse)` for streaming consumption.
    /// - Throws: `ClientError` if the request cannot be constructed,
    ///   `URLError(.userAuthenticationRequired)` if credential refresh fails,
    ///   or network errors from `URLSession`.
    public static func streamPostWithRetry(path: String, body: Data, timeout: TimeInterval = 30, session: URLSession = .shared) async throws -> (URLSession.AsyncBytes, URLResponse) {
        let connection = try resolveConnection()
        var request = try buildRequest(path: path, params: nil, method: "POST", timeout: timeout, connection: connection)
        request.setValue(sseAcceptHeader, forHTTPHeaderField: "Accept")
        request.httpBody = body
        logOutgoing(request, quiet: false)

        let (bytes, response) = try await session.bytes(for: request)

        guard let http = response as? HTTPURLResponse else {
            return (bytes, response)
        }
        logResponse(request, http: http, quiet: false)

        guard http.statusCode == 401, !connection.isManaged else {
            return (bytes, response)
        }

        // Drain the 401 response body before attempting credential refresh.
        for try await _ in bytes {}

        guard await refreshBearerCredentials(connection: connection) else {
            throw URLError(.userAuthenticationRequired, userInfo: [
                NSLocalizedDescriptionKey: "Authentication failed — please try again."
            ])
        }

        // Rebuild with fresh credentials from the credential store.
        let freshConnection = try resolveConnection()
        var retryRequest = try buildRequest(path: path, params: nil, method: "POST", timeout: timeout, connection: freshConnection)
        retryRequest.setValue(sseAcceptHeader, forHTTPHeaderField: "Accept")
        retryRequest.httpBody = body
        logOutgoing(retryRequest, quiet: false)
        let (retryBytes, retryResponse) = try await session.bytes(for: retryRequest)
        if let retryHttp = retryResponse as? HTTPURLResponse {
            logResponse(retryRequest, http: retryHttp, quiet: false)
        }
        return (retryBytes, retryResponse)
    }

    // MARK: - Internals

    #if os(macOS)
    /// Process-local override for the connected assistant ID. Used by
    /// `withAssistant(_:_:)` to temporarily route requests to a different
    /// assistant's gateway without mutating the lockfile or UserDefaults.
    /// This is concurrency-unsafe (same limitation as the old temp-swap
    /// pattern) but at least keeps the override in-process.
    private static var _assistantOverride: String?

    /// Temporarily overrides the connected assistant for the duration of
    /// `body`, so that `resolveConnectedAssistant()` resolves the given
    /// assistant instead of reading from the lockfile.
    ///
    /// This replaces the old pattern of temporarily swapping
    /// `connectedAssistantId` in UserDefaults (which was visible to the
    /// CLI and other processes).
    ///
    /// - Parameters:
    ///   - id: The assistant ID to resolve during `body`.
    ///   - body: The async work that should target the overridden assistant.
    /// - Returns: The result of `body`.
    public static func withAssistant<T>(_ id: String, _ body: () async throws -> T) async rethrows -> T {
        let previous = _assistantOverride
        _assistantOverride = id
        defer { _assistantOverride = previous }
        return try await body()
    }

    /// Resolves the currently connected assistant from the lockfile.
    ///
    /// Checks the process-local `_assistantOverride` first (set by
    /// `withAssistant(_:_:)`), then falls back to the lockfile's
    /// `activeAssistant` field via `LockfileAssistant.loadActiveAssistantId()`.
    /// As a migration fallback, reads UserDefaults `connectedAssistantId`
    /// for users upgrading from the old version whose lockfile doesn't
    /// yet have `activeAssistant`.
    private static func resolveConnectedAssistant() -> LockfileAssistant? {
        let id: String
        if let override = _assistantOverride, !override.isEmpty {
            id = override
        } else if let activeId = LockfileAssistant.loadActiveAssistantId(), !activeId.isEmpty {
            id = activeId
        } else if let legacyId = UserDefaults.standard.string(forKey: "connectedAssistantId"), !legacyId.isEmpty {
            // Migration: pre-upgrade users may not have activeAssistant in the lockfile yet.
            id = legacyId
        } else {
            return nil
        }
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
    ///   with tokens from credential storage via `SessionTokenManager` / `ActorTokenManager`.
    private static func resolveConnection() throws -> ConnectionInfo {
        #if os(macOS)
        guard let assistant = resolveConnectedAssistant() else {
            throw ClientError.noConnectedAssistant
        }

        if assistant.isManaged {
            guard let token = SessionTokenManager.getToken(), !token.isEmpty else {
                throw ClientError.notAuthenticated
            }
            let baseURL: String
            if let runtimeUrl = assistant.runtimeUrl {
                baseURL = runtimeUrl
            } else {
                baseURL = VellumEnvironment.resolvedPlatformURL
            }
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

    /// URL-path character set that preserves already-encoded percent sequences.
    /// `.urlPathAllowed` excludes `%`, which causes pre-encoded path components
    /// (e.g. `%2F` for skill slugs containing `/`) to be double-encoded as `%252F`.
    private static let urlPathPreservingEncoded: CharacterSet = {
        var cs = CharacterSet.urlPathAllowed
        cs.insert("%")
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

    /// Diagnostic summary of the current connection, intended for developer-mode UI.
    /// Returns a human-readable multi-line string with base URL, assistant ID, auth type,
    /// and managed flag. Secrets are masked. Returns the error description on failure.
    public static func connectionDiagnostics() -> String {
        do {
            let conn = try resolveConnection()
            let authType: String
            if let header = conn.authHeader {
                let maskedValue: String
                if header.value.count > 12 {
                    maskedValue = String(header.value.prefix(8)) + "…" + String(header.value.suffix(4))
                } else {
                    maskedValue = "<short>"
                }
                authType = "\(header.field): \(maskedValue)"
            } else {
                authType = "none"
            }
            return """
            Base URL: \(conn.baseURL)
            Assistant ID: \(conn.assistantId.isEmpty ? "<empty>" : conn.assistantId)
            Auth: \(authType)
            Managed: \(conn.isManaged)
            """
        } catch {
            return "Connection error: \(error.localizedDescription)"
        }
    }

    /// Credentials needed by the WebView JS fetch bridge (`window.vellum.fetch`).
    public struct WebViewCredentials {
        /// Gateway base URL including scheme and port (e.g. `http://127.0.0.1:7830`).
        public let baseURL: String
        /// Auth header entries to inject into every fetch request.
        /// Platform (managed): `["X-Session-Token": token, "Vellum-Organization-Id": orgId]`
        /// Local/remote (bearer): `["Authorization": "Bearer <jwt>"]`
        public let headers: [String: String]
        /// Path prefix inserted between `/v1/` and the user-supplied path
        /// (e.g. `"assistants/<id>/"`). Empty when `assistantId` is not available.
        public let pathPrefix: String
    }

    /// Resolves the gateway base URL and auth headers for injection into a WKWebView.
    ///
    /// Use this to populate `window.vellum.fetch` so that app frontends can call
    /// custom routes (`/v1/x/...`) with proper authentication.
    ///
    /// - Returns: A ``WebViewCredentials`` with the base URL and auth headers,
    ///   or `nil` if the connection cannot be resolved or is not authenticated.
    public static func resolveWebViewCredentials() -> WebViewCredentials? {
        guard let connection = try? resolveConnection() else { return nil }

        var headers: [String: String] = [:]
        if let auth = connection.authHeader {
            headers[auth.field] = auth.value
        }
        if connection.isManaged {
            if let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId"), !orgId.isEmpty {
                headers["Vellum-Organization-Id"] = orgId
            }
        }
        let pathPrefix: String
        if !connection.assistantId.isEmpty {
            pathPrefix = "assistants/\(connection.assistantId)/"
        } else {
            pathPrefix = ""
        }
        return WebViewCredentials(baseURL: connection.baseURL, headers: headers, pathPrefix: pathPrefix)
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

    // MARK: - WebSocket Helpers

    /// Constructs an authenticated WebSocket URL for the given gateway path.
    ///
    /// Converts the gateway base URL scheme from `http(s)` to `ws(s)` and
    /// appends an auth token as a query parameter (since `URLSessionWebSocketTask`
    /// does not support custom headers on the upgrade request). The token is
    /// passed as a `token` query parameter which the gateway accepts as an
    /// alternative to the `Authorization` header for WebSocket upgrades.
    ///
    /// - Parameters:
    ///   - path: Path segment after `/v1/` (e.g. `"stt/stream"`).
    ///   - params: Additional query parameters to include in the URL.
    /// - Returns: A `URLRequest` configured for a WebSocket upgrade with auth.
    /// - Throws: `ClientError` if the connection cannot be resolved or the URL is invalid.
    public static func buildWebSocketRequest(path: String, params: [String: String]? = nil) throws -> URLRequest {
        let connection = try resolveConnection()

        // Merge auth token into query params — WebSocket upgrades cannot carry
        // custom HTTP headers via URLSessionWebSocketTask, so the gateway
        // accepts a `token` query parameter as an alternative.
        var mergedParams = params ?? [:]
        if let auth = connection.authHeader {
            if auth.field == "Authorization", auth.value.hasPrefix("Bearer ") {
                mergedParams["token"] = String(auth.value.dropFirst("Bearer ".count))
            } else if auth.field == "X-Session-Token" {
                mergedParams["token"] = auth.value
            }
        }

        let httpURL = try constructURL(path: path, params: mergedParams, connection: connection)

        // Convert http(s) scheme to ws(s) for the WebSocket transport.
        guard var components = URLComponents(url: httpURL, resolvingAgainstBaseURL: false) else {
            throw ClientError.invalidURL
        }

        // Strip trailing slash from the path — constructURL always appends one,
        // but WebSocket upgrade handlers match exact paths (e.g. /v1/stt/stream
        // not /v1/stt/stream/).
        if components.path.hasSuffix("/"), components.path != "/" {
            components.path = String(components.path.dropLast())
        }
        switch components.scheme {
        case "https": components.scheme = "wss"
        case "http": components.scheme = "ws"
        default: break
        }
        guard let wsURL = components.url else {
            throw ClientError.invalidURL
        }

        var request = URLRequest(url: wsURL)
        // Include org ID header — URLSession forwards custom headers on the
        // initial HTTP upgrade request even for WebSocket tasks.
        if let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId"), !orgId.isEmpty {
            request.setValue(orgId, forHTTPHeaderField: "Vellum-Organization-Id")
        }
        return request
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

        let encodedPath = pathComponent.addingPercentEncoding(withAllowedCharacters: Self.urlPathPreservingEncoded) ?? pathComponent
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

    // MARK: - Logging Helpers

    /// Extracts the URL path without query parameters for logging.
    private static func logPath(from url: URL?) -> String {
        guard let url = url, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return "<nil>"
        }
        components.query = nil
        return components.string ?? url.absoluteString
    }

    private static func logOutgoing(_ request: URLRequest, quiet: Bool) {
        guard !quiet else { return }
        let path = logPath(from: request.url)
        let bodyLength = request.httpBody?.count ?? 0
        log.info("HTTP \(request.httpMethod ?? "?", privacy: .public) \(path, privacy: .public) body=\(bodyLength)B")
    }

    private static func logResponse(_ request: URLRequest, http: HTTPURLResponse, quiet: Bool) {
        guard !quiet else { return }
        let path = logPath(from: request.url)
        log.info("HTTP \(request.httpMethod ?? "?", privacy: .public) \(path, privacy: .public) → \(http.statusCode) content-length=\(http.expectedContentLength)")
    }

    /// Executes a `URLRequest` and wraps the result in a `Response`.
    private static func execute(_ request: URLRequest, quiet: Bool = false) async throws -> Response {
        logOutgoing(request, quiet: quiet)
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse {
            logResponse(request, http: http, quiet: quiet)
        }
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
        return Response(data: data, statusCode: statusCode)
    }

    /// Executes a `URLRequest` using `URLSession.download(for:)`, streaming the
    /// response body directly to a temporary file on disk.
    private static func executeDownload(_ request: URLRequest) async throws -> DownloadResponse {
        logOutgoing(request, quiet: false)
        let (tempURL, response) = try await URLSession.shared.download(for: request)
        if let http = response as? HTTPURLResponse {
            logResponse(request, http: http, quiet: false)
        }
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
        return DownloadResponse(fileURL: tempURL, statusCode: statusCode)
    }

    // MARK: - Auth Retry

    /// Executes a request with automatic 401 retry for non-managed (bearer token) connections.
    /// On a 401 response, attempts to refresh credentials via `TokenRefreshCoordinator`
    /// and retries the request once with fresh auth headers.
    private static func executeWithRetry(
        path: String,
        params: [String: String]? = nil,
        method: String,
        timeout: TimeInterval,
        quiet: Bool = false,
        skipRetry: Bool = false,
        configure: ((_ request: inout URLRequest) -> Void)? = nil
    ) async throws -> Response {
        let connection = try resolveConnection()
        var request = try buildRequest(path: path, params: params, method: method, timeout: timeout, connection: connection)
        configure?(&request)
        let response = try await execute(request, quiet: quiet)

        guard !skipRetry, response.statusCode == 401, !connection.isManaged else {
            return response
        }

        guard await refreshBearerCredentials(connection: connection) else {
            return response
        }

        // Rebuild with fresh credentials from the credential store.
        let freshConnection = try resolveConnection()
        var retryRequest = try buildRequest(path: path, params: params, method: method, timeout: timeout, connection: freshConnection)
        configure?(&retryRequest)
        return try await execute(retryRequest, quiet: quiet)
    }

    /// Attempts a bearer-token credential refresh via the shared coordinator.
    ///
    /// The coordinator coalesces concurrent refresh attempts so that only one
    /// network call is in-flight at a time — preventing the thundering-herd
    /// problem when multiple requests receive 401 simultaneously.
    ///
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

        let result = await TokenRefreshCoordinator.shared.refreshIfNeeded(
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
