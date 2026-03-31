import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "PlatformMigrationClient")

/// Direct client for platform migration endpoints (signed URL upload flow).
///
/// Unlike `GatewayHTTPClient`, which routes through the assistant-scoped proxy,
/// this client talks directly to the platform's org-scoped migration endpoints.
/// Used for teleport-to-cloud uploads where binary data must go through GCS
/// signed URLs rather than the JSON-only proxy.
public enum PlatformMigrationClient {

    // MARK: - Response Types

    /// Response from the platform's upload URL endpoint.
    public struct UploadUrlResponse: Decodable {
        public let uploadUrl: String
        public let bundleKey: String
        public let expiresAt: String

        private enum CodingKeys: String, CodingKey {
            case uploadUrl = "upload_url"
            case bundleKey = "bundle_key"
            case expiresAt = "expires_at"
        }
    }

    // MARK: - Errors

    /// Errors specific to platform migration requests.
    public enum PlatformMigrationError: LocalizedError {
        case notAuthenticated
        case signedUrlsNotAvailable
        case requestFailed(statusCode: Int, detail: String)
        case uploadFailed(statusCode: Int)

        public var errorDescription: String? {
            switch self {
            case .notAuthenticated:
                return "Not authenticated — sign in to your Vellum account to continue."
            case .signedUrlsNotAvailable:
                return "Signed URL uploads are not available — the platform may not support this feature yet."
            case .requestFailed(let statusCode, let detail):
                return "Migration request failed (HTTP \(statusCode)): \(detail)"
            case .uploadFailed(let statusCode):
                return "Bundle upload failed (HTTP \(statusCode))."
            }
        }
    }

    // MARK: - Public API

    /// Requests a signed upload URL from the platform for uploading a migration bundle.
    ///
    /// - Returns: An `UploadUrlResponse` containing the signed URL, bundle key, and expiration.
    /// - Throws: `PlatformMigrationError` on auth or request failures.
    public static func requestUploadUrl() async throws -> UploadUrlResponse {
        let (baseURL, token, orgId) = try resolveAuthContext()

        guard let url = URL(string: "\(baseURL)/v1/migrations/upload-url/") else {
            throw PlatformMigrationError.requestFailed(statusCode: 0, detail: "Invalid URL")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "X-Session-Token")
        if let orgId {
            request.setValue(orgId, forHTTPHeaderField: "Vellum-Organization-Id")
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: ["content_type": "application/octet-stream"])

        log.info("POST \(url.absoluteString, privacy: .public) — requesting upload URL")
        let (data, response) = try await URLSession.shared.data(for: request)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
        log.info("POST \(url.absoluteString, privacy: .public) → \(statusCode)")

        if statusCode == 503 || statusCode == 404 {
            throw PlatformMigrationError.signedUrlsNotAvailable
        }

        guard statusCode == 201 else {
            let detail = String(data: data, encoding: .utf8) ?? "No response body"
            throw PlatformMigrationError.requestFailed(statusCode: statusCode, detail: detail)
        }

        let decoder = JSONDecoder()
        return try decoder.decode(UploadUrlResponse.self, from: data)
    }

    /// Uploads binary bundle data to a GCS signed URL.
    ///
    /// - Parameters:
    ///   - url: The signed upload URL from `requestUploadUrl()`.
    ///   - bundleData: The raw bundle data to upload.
    /// - Throws: `PlatformMigrationError.uploadFailed` if the upload returns a non-2xx status.
    public static func uploadToSignedUrl(_ url: String, bundleData: Data) async throws {
        guard let uploadURL = URL(string: url) else {
            throw PlatformMigrationError.uploadFailed(statusCode: 0)
        }

        var request = URLRequest(url: uploadURL)
        request.httpMethod = "PUT"
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.httpBody = bundleData
        request.timeoutInterval = 600

        log.info("PUT \(uploadURL.host() ?? "signed-url", privacy: .public) — uploading bundle (\(bundleData.count) bytes)")
        let (_, response) = try await URLSession.shared.data(for: request)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
        log.info("PUT \(uploadURL.host() ?? "signed-url", privacy: .public) → \(statusCode)")

        guard (200..<300).contains(statusCode) else {
            throw PlatformMigrationError.uploadFailed(statusCode: statusCode)
        }
    }

    /// Triggers a GCS-based import on the platform after the bundle has been uploaded.
    ///
    /// - Parameter bundleKey: The bundle key returned by `requestUploadUrl()`.
    /// - Returns: A tuple of the HTTP status code and raw response data.
    /// - Throws: `PlatformMigrationError` on auth failures, or network errors from `URLSession`.
    public static func importFromGcs(bundleKey: String) async throws -> (statusCode: Int, data: Data) {
        let (baseURL, token, orgId) = try resolveAuthContext()

        guard let url = URL(string: "\(baseURL)/v1/migrations/import-from-gcs/") else {
            throw PlatformMigrationError.requestFailed(statusCode: 0, detail: "Invalid URL")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "X-Session-Token")
        if let orgId {
            request.setValue(orgId, forHTTPHeaderField: "Vellum-Organization-Id")
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: ["bundle_key": bundleKey])

        log.info("POST \(url.absoluteString, privacy: .public) — importing from GCS (key: \(bundleKey, privacy: .public))")
        let (data, response) = try await URLSession.shared.data(for: request)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
        log.info("POST \(url.absoluteString, privacy: .public) → \(statusCode)")

        return (statusCode: statusCode, data: data)
    }

    // MARK: - Internals

    /// Resolves the platform base URL, session token, and org ID for authenticated requests.
    private static func resolveAuthContext() throws -> (baseURL: String, token: String, orgId: String?) {
        guard let token = SessionTokenManager.getToken(), !token.isEmpty else {
            throw PlatformMigrationError.notAuthenticated
        }

        let baseURL = AuthService.resolveBaseURL(
            environment: ProcessInfo.processInfo.environment,
            userDefaults: .standard
        )

        let orgId: String? = {
            guard let id = UserDefaults.standard.string(forKey: "connectedOrganizationId"), !id.isEmpty else { return nil }
            return id
        }()

        return (baseURL: baseURL, token: token, orgId: orgId)
    }
}
