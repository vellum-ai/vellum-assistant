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

    /// Response from the platform's unified signed-URL endpoint.
    public struct SignedUrlResponse: Decodable {
        public let uploadUrl: String
        public let bundleKey: String
        public let expiresAt: String

        private enum CodingKeys: String, CodingKey {
            case uploadUrl = "url"
            case bundleKey = "bundle_key"
            case expiresAt = "expires_at"
        }
    }

    /// Status of an asynchronous migration job (import or export) returned by the unified job-status endpoint.
    public struct JobStatus {
        public let status: String
        public let jobId: String?
        public let error: String?
        /// Raw result data — only present when status == "complete"
        public let resultData: Data?
    }

    // MARK: - Errors

    /// Errors specific to platform migration requests.
    public enum PlatformMigrationError: LocalizedError {
        case notAuthenticated
        case signedUrlsNotAvailable
        case requestFailed(statusCode: Int, detail: String)
        case uploadFailed(statusCode: Int)
        case versionMismatch(minVersion: String, maxVersion: String?, targetVersion: String)

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
            case .versionMismatch(let minVersion, let maxVersion, let targetVersion):
                let range: String
                if let maxVersion {
                    range = "\(minVersion)–\(maxVersion)"
                } else {
                    range = "\(minVersion)+"
                }
                return "Cannot import: bundle requires runtime \(range), but this local runtime is \(targetVersion). Update your local runtime before importing."
            }
        }
    }

    // MARK: - Public API

    /// Requests a signed upload URL from the platform's unified signed-URL endpoint.
    ///
    /// POSTs to `/v1/migrations/signed-url/` with `{"operation": "upload"}`. The
    /// returned signed URL is suitable for a direct GCS PUT of bundle bytes.
    ///
    /// - Returns: A `SignedUrlResponse` containing the signed URL, bundle key, and expiration.
    /// - Throws: `PlatformMigrationError` on auth or request failures.
    public static func requestSignedUploadUrl() async throws -> SignedUrlResponse {
        let (baseURL, token, orgId) = try resolveAuthContext()

        guard let url = URL(string: "\(baseURL)/v1/migrations/signed-url/") else {
            throw PlatformMigrationError.requestFailed(statusCode: 0, detail: "Invalid URL")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "X-Session-Token")
        if let orgId {
            request.setValue(orgId, forHTTPHeaderField: "Vellum-Organization-Id")
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: ["operation": "upload"])

        let (data, statusCode) = try await executeWithRetry(
            request: request,
            label: "signed-url",
            nonRetryableStatusCodes: [404, 503]
        )

        if statusCode == 503 || statusCode == 404 {
            throw PlatformMigrationError.signedUrlsNotAvailable
        }

        guard statusCode == 201 else {
            let detail = String(data: data, encoding: .utf8) ?? "No response body"
            throw PlatformMigrationError.requestFailed(statusCode: statusCode, detail: detail)
        }

        let decoder = JSONDecoder()
        return try decoder.decode(SignedUrlResponse.self, from: data)
    }

    /// Requests a signed download URL from the platform's unified signed-URL endpoint.
    ///
    /// POSTs to `/v1/migrations/signed-url/` with
    /// `{"operation": "download", "bundle_key": ..., "target_runtime_version": ...}`.
    /// The platform validates the bundle's runtime-compat range against the
    /// target runtime version and rejects with HTTP 422 + `reason: "version_mismatch"`
    /// when there is no overlap.
    ///
    /// - Parameters:
    ///   - bundleKey: The bundle key returned by `requestSignedUploadUrl()` (and
    ///     filled by a prior `migrations/export-to-gcs` runtime export).
    ///   - targetRuntimeVersion: The runtime version that will perform the import.
    ///     Used by the platform to enforce the bundle's compat range.
    /// - Returns: The signed download URL string.
    /// - Throws: `PlatformMigrationError.versionMismatch` on 422 `version_mismatch`,
    ///   or `PlatformMigrationError.requestFailed` on other non-2xx responses.
    public static func requestSignedDownloadUrl(
        bundleKey: String,
        targetRuntimeVersion: String
    ) async throws -> String {
        let (baseURL, token, orgId) = try resolveAuthContext()

        guard let url = URL(string: "\(baseURL)/v1/migrations/signed-url/") else {
            throw PlatformMigrationError.requestFailed(statusCode: 0, detail: "Invalid URL")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "X-Session-Token")
        if let orgId {
            request.setValue(orgId, forHTTPHeaderField: "Vellum-Organization-Id")
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "operation": "download",
            "bundle_key": bundleKey,
            "target_runtime_version": targetRuntimeVersion,
        ])

        // 422 is a permanent semantic signal (version_mismatch), not a transient
        // server error — mark it non-retryable so executeWithRetry doesn't burn
        // attempts retrying a deterministic rejection.
        let (data, statusCode) = try await executeWithRetry(
            request: request,
            label: "signed-url-download",
            nonRetryableStatusCodes: [422]
        )

        if statusCode == 422 {
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               (json["reason"] as? String) == "version_mismatch",
               let compat = json["bundle_compat"] as? [String: Any],
               let minVersion = compat["min_runtime_version"] as? String,
               let targetVersion = json["target_runtime_version"] as? String {
                let maxVersion = compat["max_runtime_version"] as? String
                throw PlatformMigrationError.versionMismatch(
                    minVersion: minVersion,
                    maxVersion: maxVersion,
                    targetVersion: targetVersion
                )
            }
        }

        guard statusCode == 200 || statusCode == 201 else {
            let detail = String(data: data, encoding: .utf8) ?? "No response body"
            throw PlatformMigrationError.requestFailed(statusCode: statusCode, detail: detail)
        }

        struct DownloadUrlResponse: Decodable {
            let url: String
        }
        return try JSONDecoder().decode(DownloadUrlResponse.self, from: data).url
    }

    /// Uploads binary bundle data to a GCS signed URL.
    ///
    /// - Parameters:
    ///   - url: The signed upload URL from `requestSignedUploadUrl()`.
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
        request.timeoutInterval = 3600

        let (_, statusCode) = try await executeWithRetry(request: request, label: "signed-url-upload")

        guard (200..<300).contains(statusCode) else {
            throw PlatformMigrationError.uploadFailed(statusCode: statusCode)
        }
    }

    /// Uploads binary bundle data to a GCS signed URL with progress tracking.
    ///
    /// - Parameters:
    ///   - url: The signed upload URL from `requestSignedUploadUrl()`.
    ///   - bundleData: The raw bundle data to upload.
    ///   - onProgress: A closure called on the main actor with values from 0.0 to 1.0
    ///     representing the fraction of bytes uploaded.
    /// - Throws: `PlatformMigrationError.uploadFailed` if the upload returns a non-2xx status.
    public static func uploadToSignedUrl(
        _ url: String,
        bundleData: Data,
        onProgress: @escaping @MainActor (Double) -> Void
    ) async throws {
        guard let uploadURL = URL(string: url) else {
            throw PlatformMigrationError.uploadFailed(statusCode: 0)
        }

        var request = URLRequest(url: uploadURL)
        request.httpMethod = "PUT"
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 3600

        let delegate = UploadProgressDelegate(onProgress: onProgress)
        let session = URLSession(configuration: .default, delegate: delegate, delegateQueue: nil)
        defer {
            delegate.reset()
            session.finishTasksAndInvalidate()
        }

        let urlPath = logPath(from: uploadURL)

        for attempt in 0...maxRetries {
            log.info("PUT \(urlPath, privacy: .public)\(attempt > 0 ? " (retry \(attempt)/\(maxRetries))" : "")")
            let (_, response) = try await session.upload(for: request, from: bundleData, delegate: delegate)
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
            log.info("PUT \(urlPath, privacy: .public) → \(statusCode)")

            if attempt < maxRetries
                && retryableStatusCodes.contains(statusCode)
            {
                let delay = UInt64(pow(2.0, Double(attempt))) * 1_000_000_000
                log.warning("Transient server error (\(statusCode)) — retrying in \(1 << attempt)s")
                try await Task.sleep(nanoseconds: delay)
                delegate.reset()
                await onProgress(0)
                continue
            }

            guard (200..<300).contains(statusCode) else {
                throw PlatformMigrationError.uploadFailed(statusCode: statusCode)
            }
            return
        }

        throw PlatformMigrationError.requestFailed(statusCode: 0, detail: "Unexpected retry loop exit")
    }

    /// Downloads bundle data from a GCS signed URL.
    ///
    /// Mirrors `uploadToSignedUrl(_:bundleData:onProgress:)` in reverse: the
    /// caller passes a signed download URL (from `requestSignedDownloadUrl`)
    /// and gets back the raw bundle bytes suitable for piping into
    /// `migrations/import` on a local runtime.
    ///
    /// Retries on transient 5xx server errors (500/502/503/504) with the same
    /// 1s/2s/4s exponential backoff used elsewhere in this client.
    ///
    /// - Parameters:
    ///   - url: The signed download URL.
    ///   - onProgress: Optional closure called on the main actor with values
    ///     from 0.0 to 1.0 representing the fraction of bytes received.
    /// - Returns: The full bundle data.
    /// - Throws: `PlatformMigrationError.requestFailed` on a non-2xx status,
    ///   or any error thrown by `URLSession`.
    public static func downloadFromSignedUrl(
        _ url: String,
        onProgress: (@MainActor (Double) -> Void)? = nil
    ) async throws -> Data {
        guard let downloadURL = URL(string: url) else {
            throw PlatformMigrationError.requestFailed(statusCode: 0, detail: "Invalid URL")
        }

        var request = URLRequest(url: downloadURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 3600

        let delegate: DownloadProgressDelegate?
        let session: URLSession
        if let onProgress {
            let d = DownloadProgressDelegate(onProgress: onProgress)
            delegate = d
            session = URLSession(configuration: .default, delegate: d, delegateQueue: nil)
        } else {
            delegate = nil
            session = URLSession.shared
        }
        defer {
            delegate?.reset()
            if delegate != nil {
                session.finishTasksAndInvalidate()
            }
        }

        let urlPath = logPath(from: downloadURL)

        for attempt in 0...maxRetries {
            log.info("GET \(urlPath, privacy: .public)\(attempt > 0 ? " (retry \(attempt)/\(maxRetries))" : "")")
            let (data, response) = try await session.data(for: request, delegate: delegate)
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
            log.info("GET \(urlPath, privacy: .public) → \(statusCode)")

            if attempt < maxRetries && retryableStatusCodes.contains(statusCode) {
                let delay = UInt64(pow(2.0, Double(attempt))) * 1_000_000_000
                log.warning("Transient server error (\(statusCode)) — retrying in \(1 << attempt)s")
                try await Task.sleep(nanoseconds: delay)
                delegate?.reset()
                await onProgress?(0)
                continue
            }

            guard (200..<300).contains(statusCode) else {
                throw PlatformMigrationError.requestFailed(
                    statusCode: statusCode,
                    detail: "Bundle download failed"
                )
            }
            // Ensure the progress reaches 1.0 even if the delegate's last
            // didReceive event was throttled out by the 0.01-step gate.
            await onProgress?(1.0)
            return data
        }

        throw PlatformMigrationError.requestFailed(statusCode: 0, detail: "Unexpected retry loop exit")
    }

    /// Triggers a GCS-based import on the platform after the bundle has been uploaded.
    ///
    /// - Parameter bundleKey: The bundle key returned by `requestSignedUploadUrl()`.
    /// - Returns: A tuple of the HTTP status code and raw response data.
    /// - Throws: `PlatformMigrationError` on auth failures, or network errors from `URLSession`.
    public static func importFromGcs(bundleKey: String) async throws -> (statusCode: Int, data: Data) {
        let (baseURL, token, orgId) = try resolveAuthContext()

        guard let url = URL(string: "\(baseURL)/v1/migrations/import-from-gcs/") else {
            throw PlatformMigrationError.requestFailed(statusCode: 0, detail: "Invalid URL")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 3600
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "X-Session-Token")
        if let orgId {
            request.setValue(orgId, forHTTPHeaderField: "Vellum-Organization-Id")
        }
        request.httpBody = try JSONSerialization.data(withJSONObject: ["bundle_key": bundleKey])

        let (data, statusCode) = try await executeWithRetry(request: request, label: "import-from-gcs")

        return (statusCode: statusCode, data: data)
    }

    /// Polls the status of an asynchronous migration job.
    ///
    /// - Parameter jobId: The job ID returned by an async migration response (export or import).
    /// - Returns: A `JobStatus` with the current status, optional error, and result data.
    /// - Throws: `PlatformMigrationError` on auth or request failures.
    public static func pollJobStatus(jobId: String) async throws -> JobStatus {
        let (baseURL, token, orgId) = try resolveAuthContext()

        guard let url = URL(string: "\(baseURL)/v1/migrations/jobs/\(jobId)/") else {
            throw PlatformMigrationError.requestFailed(statusCode: 0, detail: "Invalid URL")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 30
        request.setValue(token, forHTTPHeaderField: "X-Session-Token")
        if let orgId {
            request.setValue(orgId, forHTTPHeaderField: "Vellum-Organization-Id")
        }

        let (data, statusCode) = try await executeWithRetry(request: request, label: "job-status")

        guard statusCode == 200 else {
            throw PlatformMigrationError.requestFailed(statusCode: statusCode, detail: "Job status check failed")
        }

        // Parse status and error from top level, keep raw data for result
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        let status = json["status"] as? String ?? "unknown"
        let jobIdValue = json["job_id"] as? String
        let error = json["error"] as? String

        // Re-serialize result sub-object if present
        var resultData: Data? = nil
        if let result = json["result"] {
            resultData = try? JSONSerialization.data(withJSONObject: result)
        }

        return JobStatus(status: status, jobId: jobIdValue, error: error, resultData: resultData)
    }

    // MARK: - Internals

    /// Status codes that indicate a transient server error worth retrying.
    private static let retryableStatusCodes: Set<Int> = [500, 502, 503, 504]

    /// Maximum number of retry attempts for transient server errors.
    private static let maxRetries = 3

    /// Executes a URLRequest with automatic retry on transient server errors (500/502/503/504).
    /// Uses exponential backoff: 1s, 2s, 4s between attempts.
    ///
    /// - Parameters:
    ///   - request: The URLRequest to execute.
    ///   - label: A label for logging when the URL path is unavailable.
    ///   - nonRetryableStatusCodes: Status codes that should NOT be retried even if they
    ///     appear in `retryableStatusCodes`. Use this when a caller treats certain status
    ///     codes (e.g. 503, 404) as permanent semantic signals rather than transient errors.
    private static func executeWithRetry(
        request: URLRequest,
        label: String,
        nonRetryableStatusCodes: Set<Int> = []
    ) async throws -> (data: Data, statusCode: Int) {
        let urlPath = request.url.flatMap { logPath(from: $0) } ?? label

        for attempt in 0...maxRetries {
            log.info("\(request.httpMethod ?? "?", privacy: .public) \(urlPath, privacy: .public)\(attempt > 0 ? " (retry \(attempt)/\(maxRetries))" : "")")
            let (data, response) = try await URLSession.shared.data(for: request)
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? -1
            log.info("\(request.httpMethod ?? "?", privacy: .public) \(urlPath, privacy: .public) → \(statusCode)")

            if attempt < maxRetries
                && retryableStatusCodes.contains(statusCode)
                && !nonRetryableStatusCodes.contains(statusCode)
            {
                let delay = UInt64(pow(2.0, Double(attempt))) * 1_000_000_000
                log.warning("Transient server error (\(statusCode)) — retrying in \(1 << attempt)s")
                try await Task.sleep(nanoseconds: delay)
                continue
            }

            return (data: data, statusCode: statusCode)
        }

        // Unreachable — the loop always returns on the last attempt.
        throw PlatformMigrationError.requestFailed(statusCode: 0, detail: "Unexpected retry loop exit")
    }

    /// Extracts the URL path for logging (strips query parameters and scheme).
    private static func logPath(from url: URL) -> String {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url.absoluteString
        }
        components.query = nil
        return components.path
    }

    // MARK: - Upload Progress Delegate

    /// Tracks upload progress and dispatches throttled updates to the main actor.
    /// Uses a generation counter to prevent stale callbacks from firing after reset.
    private class UploadProgressDelegate: NSObject, URLSessionTaskDelegate {
        private let onProgress: @MainActor (Double) -> Void
        private var lastReportedFraction: Double = 0.0
        private var generation: Int = 0

        init(onProgress: @escaping @MainActor (Double) -> Void) {
            self.onProgress = onProgress
        }

        func urlSession(
            _ session: URLSession,
            task: URLSessionTask,
            didSendBodyData bytesSent: Int64,
            totalBytesSent: Int64,
            totalBytesExpectedToSend: Int64
        ) {
            guard totalBytesExpectedToSend > 0 else { return }
            let progress = Double(totalBytesSent) / Double(totalBytesExpectedToSend)
            guard progress - lastReportedFraction >= 0.01 || progress >= 1.0 else { return }
            lastReportedFraction = progress
            let callback = self.onProgress
            let gen = self.generation
            Task { [weak self] in
                guard self?.generation == gen else { return }
                await callback(progress)
            }
        }

        /// Resets the throttle and increments the generation counter so any
        /// in-flight callbacks from the previous attempt are discarded.
        func reset() {
            lastReportedFraction = 0.0
            generation += 1
        }
    }

    /// Tracks download progress and dispatches throttled updates to the main actor.
    /// Mirrors `UploadProgressDelegate` but for response data instead of request body.
    private class DownloadProgressDelegate: NSObject, URLSessionDataDelegate {
        private let onProgress: @MainActor (Double) -> Void
        private var lastReportedFraction: Double = 0.0
        private var generation: Int = 0
        private var bytesReceived: Int64 = 0

        init(onProgress: @escaping @MainActor (Double) -> Void) {
            self.onProgress = onProgress
        }

        func urlSession(
            _ session: URLSession,
            dataTask: URLSessionDataTask,
            didReceive data: Data
        ) {
            bytesReceived += Int64(data.count)
            let total = dataTask.countOfBytesExpectedToReceive
            guard total > 0 else { return }
            let progress = Double(bytesReceived) / Double(total)
            guard progress - lastReportedFraction >= 0.01 || progress >= 1.0 else { return }
            lastReportedFraction = progress
            let callback = self.onProgress
            let gen = self.generation
            Task { [weak self] in
                guard self?.generation == gen else { return }
                await callback(progress)
            }
        }

        /// Resets throttle and increments the generation counter so any
        /// in-flight callbacks from the previous attempt are discarded.
        func reset() {
            lastReportedFraction = 0.0
            bytesReceived = 0
            generation += 1
        }
    }

    /// Resolves the platform base URL, session token, and org ID for authenticated requests.
    private static func resolveAuthContext() throws -> (baseURL: String, token: String, orgId: String?) {
        guard let token = SessionTokenManager.getToken(), !token.isEmpty else {
            throw PlatformMigrationError.notAuthenticated
        }

        let baseURL = VellumEnvironment.resolvedPlatformURL

        let orgId: String? = {
            guard let id = UserDefaults.standard.string(forKey: "connectedOrganizationId"), !id.isEmpty else { return nil }
            return id
        }()

        return (baseURL: baseURL, token: token, orgId: orgId)
    }
}
