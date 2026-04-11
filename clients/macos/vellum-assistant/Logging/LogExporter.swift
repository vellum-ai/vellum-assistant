import AppKit
import Foundation
import os
import OSLog
import UniformTypeIdentifiers
import VellumAssistantShared

private let log = Logger(
    subsystem: Bundle.appBundleIdentifier,
    category: "LogExporter"
)

/// Collects all assistant log sources into a single `.tar.gz` archive
/// that users can share with support for debugging.
///
/// Log sources included:
/// - `~/Library/Application Support/vellum-assistant/logs/`  — per-session JSONL diagnostic logs
/// - `~/Library/Application Support/vellum-assistant/debug-state.json` — live debug snapshot (includes transcript diagnostics)
/// - `~/Library/Application Support/vellum-assistant/hang-context.json` — hang diagnostic context written during main-thread stalls
/// - `~/Library/Application Support/vellum-assistant/hang-sample*.txt` — process sample captures from prolonged stalls
/// - Multi-service logs via `POST /v1/logs/export` gateway HTTP API — the gateway orchestrates
///   collection from all services (gateway, daemon, CES), returning a combined archive that
///   includes gateway logs, CES logs, daemon logs, audit data, and sanitized config
/// - `workspace/conversations/<dir>/` — allowlisted user conversation directories from the
///   workspace, filtered by time and conversation when applicable
/// - `~/.config/vellum/logs/` — CLI XDG logs (hatch.log, retire.log, etc.)
/// - `~/.vellum.lock.json` — sanitized lockfile with assistant entries and resource ports (credentials stripped)
/// - `user-defaults.json` — snapshot of app-relevant UserDefaults keys
/// - `auth-debug.json` — non-sensitive token expiry and refresh state for session debugging
/// - `port-diagnostics.json` — processes listening on assistant-relevant TCP ports
/// - `config-snapshot.json` — sanitized workspace config (API key values redacted, structure preserved)
/// - `crash-reports/` — recent macOS crash/hang reports (.ips, .crash, .spin) for assistant-related processes (bun, qdrant, vellum-assistant)
/// - `app-environment.json` — bundle path, quarantine xattr, and translocation status for diagnosing Gatekeeper-related launch issues
/// - `os-log.txt` — recent entries from the macOS unified log for the app's subsystem
@MainActor
enum LogExporter {

    /// Whether the currently connected assistant is a managed (platform-hosted) instance.
    /// When true, conversation-scoped exports are not available because the platform API
    /// does not yet support conversation-scoped log retrieval.
    /// Uses the cached value from AppDelegate to avoid disk I/O in hot paths (e.g. SwiftUI view bodies).
    static var isManagedAssistant: Bool {
        AppDelegate.shared?.isCurrentAssistantManaged == true
    }

    /// Maximum number of retry attempts when the server returns 413 (Request Too Large).
    /// On each retry, the largest file or directory in the staging directory is removed
    /// and logged before re-creating the archive.
    private static let maxUploadRetries = 10

    /// MIME types the platform backend accepts for feedback attachments.
    private static let allowedAttachmentMIMETypes: Set<String> = [
        "image/png", "image/jpeg", "image/gif", "image/webp",
        "video/mp4", "video/quicktime", "video/webm",
    ]

    /// Derives a MIME type string from a file URL's extension using `UTType`.
    private static func mimeType(for url: URL) -> String? {
        guard let utType = UTType(filenameExtension: url.pathExtension) else { return nil }
        return utType.preferredMIMEType
    }

    /// Collects logs, archives them, and uploads the archive to the platform API
    /// (`POST /v1/upload/feedback/`) for storage.
    /// Includes report metadata (reason, message) from the log report form.
    ///
    /// If the server returns 413 (Request Entity Too Large), the method enters a
    /// retry loop: on each iteration it finds the largest file or directory in the
    /// staging directory, removes it, appends an entry to `removed-items.log`
    /// inside the archive so support can see what was stripped, then rebuilds
    /// the tar and retries the upload.
    ///
    /// Throws if the archive build or platform upload fails. The caller is
    /// responsible for presenting success/error feedback (e.g. via a toast).
    static func sendFeedback(formData: LogReportFormData) async throws {
        let fileManager = FileManager.default
        let stagingDir = fileManager.temporaryDirectory
            .appendingPathComponent("vellum-log-export-\(UUID().uuidString)", isDirectory: true)
        let archiveURL = fileManager.temporaryDirectory
            .appendingPathComponent("vellum-assistant-logs-\(UUID().uuidString).tar.gz")

        defer {
            try? fileManager.removeItem(at: stagingDir)
            try? fileManager.removeItem(at: archiveURL)
        }

        do {
            try await buildStagingDirectory(at: stagingDir, formData: formData)
        } catch {
            log.error("Failed to build log staging directory: \(error.localizedDescription)")
            throw error
        }

        do {
            try await createTarArchive(from: stagingDir, destination: archiveURL)
        } catch {
            log.error("Failed to create log archive: \(error.localizedDescription)")
            throw error
        }

        let connectedAssistantId = LockfileAssistant.loadActiveAssistantId()

        var removedItems: [String] = []
        for attempt in 0...maxUploadRetries {
            do {
                try await uploadFeedbackToPlatform(
                    archiveURL: archiveURL,
                    formData: formData,
                    connectedAssistantId: connectedAssistantId
                )
                return
            } catch ExportError.requestTooLarge {
                guard attempt < maxUploadRetries else {
                    log.error("Upload still too large after \(maxUploadRetries) retries — giving up")
                    throw ExportError.requestTooLarge
                }

                let trimResult = try await trimStagingAndRebuildArchive(
                    stagingDir: stagingDir,
                    archiveURL: archiveURL,
                    previouslyRemoved: removedItems
                )

                guard let removed = trimResult else {
                    log.error("No more items to remove but request is still too large")
                    throw ExportError.requestTooLarge
                }

                removedItems.append(removed)
                log.info("Removed \(removed) from staging dir (attempt \(attempt + 1)) — rebuilding archive")
            }
        }
    }

    // MARK: - Platform Feedback Upload

    /// Maps `LogReportReason` to the platform API's `FeedbackClassification` values.
    static func feedbackClassification(for reason: LogReportReason) -> String {
        switch reason {
        case .bugReport: return "bug_report"
        case .featureRequest: return "feature_request"
        case .other: return "other"
        }
    }

    /// Uploads the feedback archive and metadata to the platform API.
    /// Throws ``ExportError/requestTooLarge`` on HTTP 413 so the caller can
    /// enter the retry loop. Throws `URLError` for other failures.
    private static func uploadFeedbackToPlatform(
        archiveURL: URL,
        formData: LogReportFormData,
        connectedAssistantId: String?
    ) async throws {
        let baseURL = VellumEnvironment.resolvedPlatformURL
        guard let url = URL(string: "\(baseURL)/v1/upload/feedback/") else {
            log.warning("Failed to construct platform feedback URL")
            throw URLError(.badURL)
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 60

        // Add auth headers if the user is authenticated (managed assistant).
        if let token = await SessionTokenManager.getTokenAsync() {
            request.setValue(token, forHTTPHeaderField: "X-Session-Token")
        }
        if let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId"), !orgId.isEmpty {
            request.setValue(orgId, forHTTPHeaderField: "Vellum-Organization-Id")
        }

        // Build multipart/form-data body.
        let boundary = UUID().uuidString
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()

        // Text fields
        appendFormField(&body, boundary: boundary, name: "message", value: formData.message)
        appendFormField(&body, boundary: boundary, name: "classification", value: feedbackClassification(for: formData.reason))
        appendFormField(&body, boundary: boundary, name: "email", value: formData.email)

        appendFormField(&body, boundary: boundary, name: "device_id", value: SentryDeviceInfo.deviceId)

        if let clientVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String {
            appendFormField(&body, boundary: boundary, name: "client_version", value: clientVersion)
        }

        if let assistantId = connectedAssistantId,
           let assistantVersion = LockfileAssistant.loadByName(assistantId)?.serviceGroupVersion {
            appendFormField(&body, boundary: boundary, name: "assistant_version", value: assistantVersion)
        }

        if let assistantId = connectedAssistantId {
            appendFormField(&body, boundary: boundary, name: "assistant_id", value: assistantId)
        }

        // File part — the tar.gz archive
        if let archiveData = try? Data(contentsOf: archiveURL) {
            let filename = defaultArchiveName()
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"logs_file\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
            body.append("Content-Type: application/gzip\r\n\r\n".data(using: .utf8)!)
            body.append(archiveData)
            body.append("\r\n".data(using: .utf8)!)
        } else {
            log.warning("Failed to read archive at \(archiveURL.path) — submitting feedback without logs")
        }

        // Attachment file parts — read data off the main thread to avoid
        // blocking the UI for large files (up to 50 MB each).
        for attachmentURL in formData.attachments {
            guard let mime = mimeType(for: attachmentURL),
                  allowedAttachmentMIMETypes.contains(mime) else {
                log.warning("Skipping invalid attachment at \(attachmentURL.lastPathComponent)")
                continue
            }
            guard let fileData = await Task.detached(operation: { try? Data(contentsOf: attachmentURL) }).value else {
                log.warning("Skipping unreadable attachment at \(attachmentURL.lastPathComponent)")
                continue
            }
            let filename = attachmentURL.lastPathComponent
                .replacingOccurrences(of: "\"", with: "_")
                .replacingOccurrences(of: "\r", with: "_")
                .replacingOccurrences(of: "\n", with: "_")
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"attachments\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
            body.append("Content-Type: \(mime)\r\n\r\n".data(using: .utf8)!)
            body.append(fileData)
            body.append("\r\n".data(using: .utf8)!)
        }

        // Final boundary
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)

        request.httpBody = body

        let (_, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            log.warning("Platform feedback upload failed with status \(http.statusCode)")
            if http.statusCode == 413 {
                throw ExportError.requestTooLarge
            }
            throw URLError(.badServerResponse)
        } else {
            log.info("Platform feedback upload succeeded")
        }
    }

    /// Appends a simple text field to a multipart/form-data body.
    private static func appendFormField(_ body: inout Data, boundary: String, name: String, value: String) {
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".data(using: .utf8)!)
        body.append("\(value)\r\n".data(using: .utf8)!)
    }

    // MARK: - Private

    private static func defaultArchiveName() -> String {
        let timestamp = Date().iso8601String
            .replacingOccurrences(of: ":", with: "-")
        return "vellum-assistant-logs-\(timestamp).tar.gz"
    }

    /// Populates a staging directory with all log sources.
    /// The staging directory is managed by the caller.
    private nonisolated static func buildStagingDirectory(
        at stagingDir: URL,
        formData: LogReportFormData? = nil
    ) async throws {
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: stagingDir, withIntermediateDirectories: true)
        try await populateStagingDirectory(at: stagingDir, formData: formData, fileManager: fileManager)
    }

    /// Collects all log sources into the given staging directory.
    private nonisolated static func populateStagingDirectory(
        at tempDir: URL,
        formData: LogReportFormData?,
        fileManager: FileManager
    ) async throws {

        let home = NSHomeDirectory()
        let connectedId = LockfileAssistant.loadActiveAssistantId()
        let connectedAssistant = connectedId.flatMap { LockfileAssistant.loadByName($0) }
        var daemonUnreachable = false

        let cutoffDate: Date? = formData?.logTimeRange.cutoffDate

        let shouldCollectLogs = formData?.includeLogs ?? true
        if shouldCollectLogs {
            // 1-2. Client artifacts — session logs, debug-state, hang-context, hang-sample files
            if let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
                let appSupportDir = appSupport.appendingPathComponent("vellum-assistant", isDirectory: true)
                collectClientArtifacts(from: appSupportDir, into: tempDir, cutoffDate: cutoffDate, fileManager: fileManager)
            }

            // 3. Assistant logs — platform API for managed, local gateway for self-hosted
            let isManagedAssistant = connectedAssistant?.isManaged == true

            if isManagedAssistant, let assistantId = connectedId,
               let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId") {
                // TODO: fetchPlatformLogs does not yet support time-range filtering.
                // The platform export API would need a startTime parameter to respect cutoffDate here.
                await fetchPlatformLogs(into: tempDir, assistantId: assistantId, organizationId: orgId)
            } else {
                let success = await fetchServiceExports(into: tempDir, scope: formData?.scope ?? .global, cutoffDate: cutoffDate)
                if !success {
                    daemonUnreachable = true
                }
            }

            // 4. XDG CLI logs — ~/.config/vellum/logs/ (hatch.log, retire.log, etc.)
            let xdgConfigHome = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"]
                ?? URL(fileURLWithPath: home).appendingPathComponent(".config").path
            let xdgLogDir = URL(fileURLWithPath: xdgConfigHome)
                .appendingPathComponent("vellum/logs", isDirectory: true)
            copyDirectoryContents(
                from: xdgLogDir,
                to: tempDir.appendingPathComponent("xdg-logs", isDirectory: true),
                fileManager: fileManager,
                cutoffDate: cutoffDate
            )

            // 5. Lockfile — ~/.vellum.lock.json (sanitized to strip credentials)
            writeSanitizedLockfile(
                to: tempDir.appendingPathComponent("vellum.lock.json")
            )

            // 6. UserDefaults snapshot — app-relevant keys for debugging
            writeUserDefaultsSnapshot(
                to: tempDir.appendingPathComponent("user-defaults.json")
            )

            // 7. Auth debug info — non-sensitive token expiry and refresh metadata
            writeAuthDebugInfo(
                to: tempDir.appendingPathComponent("auth-debug.json")
            )

            // 8. Port diagnostics — which processes are listening on assistant ports
            PortDiagnostics.write(
                to: tempDir.appendingPathComponent("port-diagnostics.json")
            )

            // 8a. App environment — bundle path, quarantine xattr, translocation status
            BundleEnvironment.write(
                to: tempDir.appendingPathComponent("app-environment.json")
            )

            // 9. macOS crash/hang reports — recent .ips/.crash/.spin files for assistant-related processes
            collectCrashReports(
                into: tempDir.appendingPathComponent("crash-reports", isDirectory: true),
                fileManager: fileManager,
                cutoffDate: cutoffDate
            )
        }

        // 10. Report metadata — reason and message from the log report form.
        // Always written regardless of includeLogs, since it contains the reason/message/email.
        // Email is sent separately via the platform API form fields.
        if let formData {
            var metadata: [String: Any] = [
                "reason": formData.reason.rawValue,
                "message": formData.message,
                "log_time_range": formData.logTimeRange.rawValue,
                // device_id intentionally matches ~/.vellum/device.json UUID
                // so log exports correlate with daemon Sentry events and telemetry.
                "device_id": SentryDeviceInfo.deviceId,
            ]
            // user_id mirrors the Sentry user tag set by SentryDeviceInfo.updateUserTag
            // so log exports can be correlated with authenticated Sentry events.
            if let userId = await MainActor.run(body: { AppDelegate.shared?.authManager.currentUser?.id }) {
                metadata["user_id"] = userId
            }
            if !formData.name.isEmpty {
                metadata["name"] = formData.name
            }
            if daemonUnreachable {
                metadata["daemon-unreachable"] = true
            }
            if let assistantVersion = connectedAssistant?.serviceGroupVersion {
                metadata["assistant_version"] = assistantVersion
            }
            if let clientVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String {
                metadata["client_version"] = clientVersion
            }
            if let data = try? JSONSerialization.data(
                withJSONObject: metadata,
                options: [.prettyPrinted, .sortedKeys]
            ) {
                try? data.write(to: tempDir.appendingPathComponent("report-metadata.json"))
            }
        } else if daemonUnreachable {
                // Write a minimal manifest when no form data is available so the
                // receiving end still knows the daemon was unreachable during export.
            var manifest: [String: Any] = ["daemon-unreachable": true]
            if let assistantVersion = connectedAssistant?.serviceGroupVersion {
                manifest["assistant_version"] = assistantVersion
            }
            if let clientVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String {
                manifest["client_version"] = clientVersion
            }
            if let data = try? JSONSerialization.data(
                withJSONObject: manifest,
                options: [.prettyPrinted, .sortedKeys]
            ) {
                try? data.write(to: tempDir.appendingPathComponent("report-metadata.json"))
            }
        }

        if shouldCollectLogs {
            // 11. macOS unified log — recent os.Logger entries for this app's subsystem.
            collectUnifiedLog(
                to: tempDir.appendingPathComponent("os-log.txt"),
                cutoffDate: cutoffDate
            )

            // 12. Sanitized workspace config — client-side fallback if service export didn't include it.
            //     The gateway archive extracts into service-exports/, and the daemon archive is nested
            //     inside it under daemon-exports/, so check both locations.
            let configSnapshotPath = tempDir.appendingPathComponent("config-snapshot.json")
            let serviceConfigPath = tempDir.appendingPathComponent("service-exports/daemon-exports/config-snapshot.json")
            if !fileManager.fileExists(atPath: configSnapshotPath.path)
                && !fileManager.fileExists(atPath: serviceConfigPath.path) {
                await writeSanitizedWorkspaceConfig(to: configSnapshotPath)
            }
        }

        // Verify we have at least one file to export
        let collected = try fileManager.contentsOfDirectory(
            at: tempDir,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )
        guard !collected.isEmpty else {
            throw ExportError.noLogsFound
        }
    }

    /// Creates a tar.gz archive from the contents of `sourceDir`.
    private nonisolated static func createTarArchive(from sourceDir: URL, destination: URL) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
            process.arguments = [
                "czf",
                destination.path,
                "-C", sourceDir.path,
                ".",
            ]

            let pipe = Pipe()
            process.standardError = pipe

            process.terminationHandler = { proc in
                if proc.terminationStatus == 0 {
                    continuation.resume()
                } else {
                    let stderr = String(
                        data: pipe.fileHandleForReading.readDataToEndOfFile(),
                        encoding: .utf8
                    ) ?? ""
                    continuation.resume(throwing: ExportError.tarFailed(stderr))
                }
            }

            do {
                try process.run()
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }

    // MARK: - Client Artifact Collection

    /// Copies client-side diagnostic artifacts from the Application Support
    /// `vellum-assistant/` directory into the export staging directory.
    ///
    /// Artifacts collected:
    /// - `logs/` — per-session JSONL diagnostic logs (→ `session-logs/`)
    /// - `debug-state.json` — live debug snapshot
    /// - `hang-context.json` — hang diagnostic context from main-thread stalls
    /// - `hang-sample*.txt` — process sample captures from prolonged stalls
    ///
    /// All copies are best-effort: missing files are silently skipped.
    nonisolated static func collectClientArtifacts(
        from sourceDir: URL,
        into destDir: URL,
        cutoffDate: Date? = nil,
        fileManager: FileManager = .default
    ) {
        // Session logs — filter by modification date when cutoffDate is set
        let sessionLogDir = sourceDir.appendingPathComponent("logs", isDirectory: true)
        if let cutoffDate {
            // Enumerate files and include only those modified at or after the cutoff
            if fileManager.fileExists(atPath: sessionLogDir.path),
               let files = try? fileManager.contentsOfDirectory(
                   at: sessionLogDir,
                   includingPropertiesForKeys: [.contentModificationDateKey],
                   options: [.skipsHiddenFiles]
               ) {
                let filtered = files.filter { url in
                    guard let values = try? url.resourceValues(forKeys: [.contentModificationDateKey]),
                          let modDate = values.contentModificationDate else {
                        // Include files whose modification date can't be read to avoid data loss
                        return true
                    }
                    return modDate >= cutoffDate
                }

                if !filtered.isEmpty {
                    let sessionLogDest = destDir.appendingPathComponent("session-logs", isDirectory: true)
                    try? fileManager.createDirectory(at: sessionLogDest, withIntermediateDirectories: true)
                    for file in filtered {
                        try? fileManager.copyItem(
                            at: file,
                            to: sessionLogDest.appendingPathComponent(file.lastPathComponent)
                        )
                    }
                }
            }
        } else {
            // No cutoff — copy all session logs (existing behavior)
            copyDirectoryContents(
                from: sessionLogDir,
                to: destDir.appendingPathComponent("session-logs", isDirectory: true),
                fileManager: fileManager
            )
        }

        // Debug state snapshot
        let debugState = sourceDir.appendingPathComponent("debug-state.json")
        if fileManager.fileExists(atPath: debugState.path) {
            try? fileManager.copyItem(
                at: debugState,
                to: destDir.appendingPathComponent("debug-state.json")
            )
        }

        // Hang context — written by MainThreadStallDetector during prolonged stalls
        let hangContext = sourceDir.appendingPathComponent("hang-context.json")
        if fileManager.fileExists(atPath: hangContext.path) {
            try? fileManager.copyItem(
                at: hangContext,
                to: destDir.appendingPathComponent("hang-context.json")
            )
        }

        // Hang sample files — process samples captured during prolonged main-thread stalls
        if fileManager.fileExists(atPath: sourceDir.path),
           let contents = try? fileManager.contentsOfDirectory(
               at: sourceDir,
               includingPropertiesForKeys: nil,
               options: [.skipsHiddenFiles]
           ) {
            for file in contents where file.lastPathComponent.hasPrefix("hang-sample")
                && file.pathExtension == "txt" {
                try? fileManager.copyItem(
                    at: file,
                    to: destDir.appendingPathComponent(file.lastPathComponent)
                )
            }
        }
    }

    /// Copies all files from `source` into `dest`, creating `dest` if needed.
    /// Silently skips if `source` doesn't exist or is empty.
    ///
    /// When `cutoffDate` is non-nil, only files whose content modification date
    /// is on or after the cutoff are copied. Files without a readable modification
    /// date are included to avoid silently dropping data.
    private nonisolated static func copyDirectoryContents(
        from source: URL,
        to dest: URL,
        fileManager: FileManager,
        cutoffDate: Date? = nil
    ) {
        guard fileManager.fileExists(atPath: source.path) else { return }
        guard let items = try? fileManager.contentsOfDirectory(
            at: source,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ), !items.isEmpty else { return }

        let filtered: [URL]
        if let cutoff = cutoffDate {
            filtered = items.filter { url in
                guard let values = try? url.resourceValues(forKeys: [.contentModificationDateKey]),
                      let modDate = values.contentModificationDate else {
                    // Include files whose modification date can't be read
                    return true
                }
                return modDate >= cutoff
            }
        } else {
            filtered = items
        }

        guard !filtered.isEmpty else { return }
        try? fileManager.createDirectory(at: dest, withIntermediateDirectories: true)
        for item in filtered {
            try? fileManager.copyItem(
                at: item,
                to: dest.appendingPathComponent(item.lastPathComponent)
            )
        }
    }

    // MARK: - Assistant Export Helpers

    /// Calls POST /v1/logs/export on the gateway to download a tar.gz archive
    /// containing logs from all services (gateway, daemon, CES), along with
    /// audit data and config snapshot.
    /// Extracts the archive into `directory/service-exports/`.
    /// Returns `true` if the export succeeded, `false` if the assistant was unreachable.
    ///
    /// The gateway's orchestrating endpoint collects logs from all services and
    /// combines them into a single archive. The daemon archive is nested inside
    /// the gateway archive under `daemon-exports/`.
    ///
    /// On failure, writes an `export-error.log` into `directory` with the
    /// status code and response body so the feedback bundle still contains
    /// diagnostic context about the failed export.
    ///
    /// Routes through ``GatewayHTTPClient`` so auth and connection resolution
    /// are handled consistently for both local and managed assistants.
    @discardableResult
    private nonisolated static func fetchServiceExports(into directory: URL, scope: LogExportScope, cutoffDate: Date? = nil) async -> Bool {
        var body: [String: Any] = ["auditLimit": 1000]
        if case .conversation(let conversationId, _, let startTime, let endTime) = scope {
            body["conversationId"] = conversationId
            if let startTime {
                body["startTime"] = Int(startTime.timeIntervalSince1970 * 1000)
            } else if let cutoffDate {
                body["startTime"] = Int(cutoffDate.timeIntervalSince1970 * 1000)
            }
            if let endTime {
                body["endTime"] = Int(endTime.timeIntervalSince1970 * 1000)
            }
        } else if let cutoffDate {
            body["startTime"] = Int(cutoffDate.timeIntervalSince1970 * 1000)
        }

        do {
            let response = try await GatewayHTTPClient.post(path: "logs/export", json: body, timeout: 60)
            guard response.isSuccess else {
                log.warning("Export API failed with status \(response.statusCode)")
                writeExportErrorLog(
                    to: directory.appendingPathComponent("export-error.log"),
                    source: "service-export",
                    statusCode: response.statusCode,
                    responseData: response.data
                )
                return false
            }

            try await extractTarGzResponse(data: response.data, into: directory, subdirectory: "service-exports")
            return true
        } catch {
            log.warning("Export API request failed: \(error.localizedDescription)")
            writeExportErrorLog(
                to: directory.appendingPathComponent("export-error.log"),
                source: "service-export",
                error: error
            )
            return false
        }
    }

    /// Reads the first `bytes` bytes from `source` and writes them to `destination`.
    private nonisolated static func copyHead(of source: URL, bytes: Int, to destination: URL) {
        guard let handle = try? FileHandle(forReadingFrom: source) else { return }
        defer { try? handle.close() }

        let data = handle.readData(ofLength: bytes)
        try? data.write(to: destination)
    }

    // MARK: - Crash Report Collection

    /// Process names to match in DiagnosticReports filenames.
    /// macOS names crash files `<process>-<date>-<time>.<ext>` or
    /// `<process>_<date>-<time>_<host>.<ext>`. The match requires the
    /// process name to be followed by a separator (`-`, `_`, or `.`)
    /// to avoid false positives from unrelated processes whose names
    /// share a prefix (e.g. `bundle`, `nodekit`).
    private nonisolated static let crashReportProcessNames = [
        "bun",
        "node",
        "qdrant",
        "vellum-assistant",
    ]

    /// File extensions recognised as crash/hang reports.
    private nonisolated static let crashReportExtensions: Set<String> = ["ips", "crash", "spin"]

    /// Maximum total bytes to copy from crash reports.
    private nonisolated static let crashReportSizeLimit = 5 * 1024 * 1024 // 5 MB

    /// Collects recent macOS crash and hang reports for assistant-related
    /// processes from `~/Library/Logs/DiagnosticReports/`.
    /// Only files from the last 7 days that match known process names are
    /// included, capped at 5 MB total (newest first).
    private nonisolated static func collectCrashReports(
        into dest: URL,
        fileManager: FileManager,
        cutoffDate: Date? = nil
    ) {
        let home = NSHomeDirectory()
        let reportsDir = URL(fileURLWithPath: home)
            .appendingPathComponent("Library/Logs/DiagnosticReports", isDirectory: true)
        guard fileManager.fileExists(atPath: reportsDir.path) else { return }

        guard let contents = try? fileManager.contentsOfDirectory(
            at: reportsDir,
            includingPropertiesForKeys: [.contentModificationDateKey, .fileSizeKey],
            options: [.skipsHiddenFiles]
        ) else { return }

        let cutoff = cutoffDate ?? Date().addingTimeInterval(-7 * 24 * 60 * 60)

        // Filter to matching files, then sort newest-first
        let matching = contents
            .filter { url in
                guard crashReportExtensions.contains(url.pathExtension.lowercased()) else {
                    return false
                }
                let name = url.lastPathComponent
                guard crashReportProcessNames.contains(where: { processName in
                    guard name.hasPrefix(processName) else { return false }
                    guard let next = name.dropFirst(processName.count).first else { return false }
                    return next == "-" || next == "_" || next == "."
                }) else {
                    return false
                }
                guard let values = try? url.resourceValues(forKeys: [.contentModificationDateKey]),
                      let modDate = values.contentModificationDate,
                      modDate >= cutoff else {
                    return false
                }
                return true
            }
            .sorted { a, b in
                let aDate = (try? a.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                let bDate = (try? b.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                return aDate > bDate
            }

        guard !matching.isEmpty else { return }
        try? fileManager.createDirectory(at: dest, withIntermediateDirectories: true)

        var totalBytes = 0
        var collectedCount = 0
        for file in matching {
            guard totalBytes < crashReportSizeLimit else { break }
            guard let values = try? file.resourceValues(forKeys: [.fileSizeKey]),
                  let size = values.fileSize,
                  size > 0 else { continue }

            let bytesToRead = min(size, crashReportSizeLimit - totalBytes)
            if bytesToRead >= size {
                try? fileManager.copyItem(
                    at: file,
                    to: dest.appendingPathComponent(file.lastPathComponent)
                )
            } else {
                // Truncate oversized reports — read from the start to
                // preserve the header (process name, exception, crashed thread).
                copyHead(
                    of: file,
                    bytes: bytesToRead,
                    to: dest.appendingPathComponent(file.lastPathComponent)
                )
            }
            totalBytes += bytesToRead
            collectedCount += 1
        }

        log.info("Collected \(collectedCount) crash report(s) (\(totalBytes) bytes)")
    }

    // MARK: - Unified Log Export

    /// Exports recent entries from Apple's unified logging system (`os.Logger`)
    /// for this app's subsystem. Includes CLI audit trail, lifecycle events,
    /// and any other structured log output not written to files on disk.
    ///
    /// Uses `OSLogStore` to read entries starting from `cutoffDate`, or the
    /// last 24 hours when no cutoff is provided. Falls back silently if the
    /// API is unavailable or the subsystem has no entries.
    private nonisolated static func collectUnifiedLog(to destination: URL, cutoffDate: Date? = nil) {
        do {
            let store = try OSLogStore(scope: .currentProcessIdentifier)
            let logCutoff = cutoffDate ?? Date().addingTimeInterval(-86400)
            let position = store.position(date: logCutoff)
            let subsystem = Bundle.appBundleIdentifier

            let entries = try store.getEntries(
                at: position,
                matching: NSPredicate(format: "subsystem == %@", subsystem)
            )

            var lines: [String] = []

            for entry in entries {
                guard let logEntry = entry as? OSLogEntryLog else { continue }
                let ts = logEntry.date.iso8601WithFractionalSecondsString
                let level: String
                switch logEntry.level {
                case .debug: level = "DEBUG"
                case .info: level = "INFO"
                case .notice: level = "NOTICE"
                case .error: level = "ERROR"
                case .fault: level = "FAULT"
                default: level = "OTHER"
                }
                lines.append("[\(ts)] [\(level)] [\(logEntry.category)] \(logEntry.composedMessage)")
            }

            guard !lines.isEmpty else { return }
            let content = lines.joined(separator: "\n")
            try content.write(to: destination, atomically: true, encoding: .utf8)
            log.info("Exported \(lines.count) unified log entries to os-log.txt")
        } catch {
            log.warning("Failed to export unified log: \(error.localizedDescription)")
        }
    }

    // MARK: - Platform Log Helpers

    /// Fetches logs from the platform API for managed assistants, downloads
    /// the tar.gz response, extracts it into `directory/platform-logs/`.
    ///
    /// On failure, writes a `platform-export-error.log` into `directory` with
    /// the status code and response body so the feedback bundle still contains
    /// diagnostic context about the failed export.
    private nonisolated static func fetchPlatformLogs(
        into directory: URL,
        assistantId: String,
        organizationId: String
    ) async {
        guard let token = SessionTokenManager.getToken() else {
            log.warning("No session token available — skipping platform log export")
            writeExportErrorLog(
                to: directory.appendingPathComponent("platform-export-error.log"),
                source: "platform-log-export",
                error: nil,
                note: "No session token available"
            )
            return
        }

        let baseURL = VellumEnvironment.resolvedPlatformURL

        guard let url = URL(string: "\(baseURL)/v1/assistants/\(assistantId)/logs/export/") else {
            log.warning("Failed to construct platform log export URL")
            writeExportErrorLog(
                to: directory.appendingPathComponent("platform-export-error.log"),
                source: "platform-log-export",
                error: nil,
                note: "Failed to construct URL: \(baseURL)/v1/assistants/\(assistantId)/logs/export/"
            )
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.setValue(token, forHTTPHeaderField: "X-Session-Token")
        request.setValue(organizationId, forHTTPHeaderField: "Vellum-Organization-Id")

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200...299).contains(http.statusCode) else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? -1
                log.warning("Platform log export API failed with status \(status)")
                writeExportErrorLog(
                    to: directory.appendingPathComponent("platform-export-error.log"),
                    source: "platform-log-export",
                    statusCode: status,
                    responseData: data
                )
                return
            }

            try await extractTarGzResponse(data: data, into: directory, subdirectory: "platform-logs")
        } catch {
            log.warning("Platform log export request failed: \(error.localizedDescription)")
            writeExportErrorLog(
                to: directory.appendingPathComponent("platform-export-error.log"),
                source: "platform-log-export",
                error: error
            )
        }
    }

    /// Writes tar.gz `data` to a temporary file and extracts it into
    /// `directory/<subdirectory>/` using `/usr/bin/tar`.
    /// Validates archive member paths before extraction to prevent path traversal.
    private nonisolated static func extractTarGzResponse(
        data: Data,
        into directory: URL,
        subdirectory: String
    ) async throws {
        let fileManager = FileManager.default
        let tarPath = fileManager.temporaryDirectory
            .appendingPathComponent("\(subdirectory)-\(UUID().uuidString).tar.gz")
        try data.write(to: tarPath)

        defer {
            try? fileManager.removeItem(at: tarPath)
        }

        // Validate archive contents — reject paths with ".." components or absolute paths
        try await validateTarContents(at: tarPath)

        let extractDir = directory.appendingPathComponent(subdirectory, isDirectory: true)
        try fileManager.createDirectory(at: extractDir, withIntermediateDirectories: true)

        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
            process.arguments = [
                "xzf",
                tarPath.path,
                "-C", extractDir.path,
            ]

            let pipe = Pipe()
            process.standardError = pipe

            process.terminationHandler = { proc in
                if proc.terminationStatus == 0 {
                    continuation.resume()
                } else {
                    let stderr = String(
                        data: pipe.fileHandleForReading.readDataToEndOfFile(),
                        encoding: .utf8
                    ) ?? ""
                    continuation.resume(throwing: ExportError.tarFailed(stderr))
                }
            }

            do {
                try process.run()
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }

    /// Lists tar archive members and rejects any with path traversal (`..`) or absolute paths.
    private nonisolated static func validateTarContents(at tarPath: URL) async throws {
        let entries = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<String, Error>) in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
            process.arguments = ["tzf", tarPath.path]

            let pipe = Pipe()
            process.standardOutput = pipe

            let errPipe = Pipe()
            process.standardError = errPipe

            do {
                try process.run()
            } catch {
                continuation.resume(throwing: error)
                return
            }

            // Drain both pipes concurrently to prevent deadlock.
            // Sequential reads can block if tar fills one pipe buffer (~64 KB)
            // while we're waiting on the other.
            nonisolated(unsafe) var stdoutData = Data()
            nonisolated(unsafe) var stderrData = Data()
            let group = DispatchGroup()

            group.enter()
            DispatchQueue.global(qos: .utility).async {
                stdoutData = pipe.fileHandleForReading.readDataToEndOfFile()
                group.leave()
            }

            group.enter()
            DispatchQueue.global(qos: .utility).async {
                stderrData = errPipe.fileHandleForReading.readDataToEndOfFile()
                group.leave()
            }

            group.wait()

            process.waitUntilExit()

            if process.terminationStatus == 0 {
                let output = String(data: stdoutData, encoding: .utf8) ?? ""
                continuation.resume(returning: output)
            } else {
                let stderr = String(data: stderrData, encoding: .utf8) ?? ""
                continuation.resume(throwing: ExportError.tarFailed("Failed to list archive: \(stderr)"))
            }
        }

        for entry in entries.split(separator: "\n") {
            let path = String(entry)
            if path.hasPrefix("/") {
                log.warning("Rejecting archive with absolute path: \(path)")
                throw ExportError.unsafeArchivePath(path)
            }
            let components = (path as NSString).pathComponents
            if components.contains("..") {
                log.warning("Rejecting archive with path traversal: \(path)")
                throw ExportError.unsafeArchivePath(path)
            }
        }
    }

    // MARK: - Snapshot Helpers

    /// Writes a sanitized copy of the lockfile with credential fields stripped.
    /// Preserves all structural data (assistant IDs, cloud, ports, timestamps)
    /// while replacing `bearerToken` and `runtimeUrl` with boolean presence flags.
    private nonisolated static func writeSanitizedLockfile(to url: URL) {
        guard let json = LockfilePaths.read() else { return }

        var sanitized = json
        if var assistants = json["assistants"] as? [[String: Any]] {
            for i in assistants.indices {
                let hasBearerToken = assistants[i]["bearerToken"] != nil
                let hasRuntimeUrl = assistants[i]["runtimeUrl"] != nil
                assistants[i].removeValue(forKey: "bearerToken")
                assistants[i].removeValue(forKey: "runtimeUrl")
                assistants[i]["hasBearerToken"] = hasBearerToken
                assistants[i]["hasRuntimeUrl"] = hasRuntimeUrl
            }
            sanitized["assistants"] = assistants
        }

        guard let data = try? JSONSerialization.data(
            withJSONObject: sanitized,
            options: [.prettyPrinted, .sortedKeys]
        ) else { return }
        try? data.write(to: url)
    }

    /// Writes a JSON snapshot of app-relevant UserDefaults keys.
    /// Values are included as-is for non-sensitive keys; sensitive keys are
    /// represented as presence/absence only.
    private nonisolated static func writeUserDefaultsSnapshot(to url: URL) {
        let defaults = UserDefaults.standard

        let stringKeys = [
            "connectedOrganizationId",
            "activationKey",
            "onboarding.step",
            "onboarding.name",
            "onboarding.key",
            "onboarding.cloudProvider",
            "onboarding.variant",
            "onboarding.flowVersion",
            "lastActivePanel",
            "gateway_base_url",
            "conversation_key",
            "sidebarExpanded",
            "windowZoomLevel",
            "collectUsageData",
            "sendDiagnostics",
            "ttsVoiceId",
            "selectedImageGenModel",
        ]

        let boolKeys = [
            "onboarding.hatched",
            "onboarding.interviewCompleted",
        ]

        var snapshot: [String: Any] = [:]
        for key in stringKeys {
            if let value = defaults.object(forKey: key) {
                snapshot[key] = value
            }
        }
        for key in boolKeys {
            snapshot[key] = defaults.bool(forKey: key)
        }

        guard let data = try? JSONSerialization.data(
            withJSONObject: snapshot,
            options: [.prettyPrinted, .sortedKeys]
        ) else { return }
        try? data.write(to: url)
    }

    /// Writes non-sensitive auth/session debug metadata: token presence,
    /// expiry timestamps, and refresh state. Actual token values are never included.
    private nonisolated static func writeAuthDebugInfo(to url: URL) {
        let now = Int(Date().timeIntervalSince1970 * 1000)

        let accessTokenExpiresAt = ActorTokenManager.getActorTokenExpiresAt()
        let refreshTokenExpiresAt = ActorTokenManager.getRefreshTokenExpiresAt()
        let refreshAfter = ActorTokenManager.getRefreshAfter()

        var info: [String: Any] = [
            "exportedAt": Date().iso8601String,
            "nowEpochMs": now,
            "hasActorToken": ActorTokenManager.hasToken,
            "hasRefreshToken": ActorTokenManager.getRefreshToken() != nil,
            "hasSessionToken": SessionTokenManager.getToken() != nil,
            "needsProactiveRefresh": ActorTokenManager.needsProactiveRefresh,
            "isRefreshTokenExpired": ActorTokenManager.isRefreshTokenExpired,
        ]

        if let expiresAt = accessTokenExpiresAt {
            info["accessTokenExpiresAt"] = expiresAt
            info["accessTokenExpired"] = now >= expiresAt
        }
        if let expiresAt = refreshTokenExpiresAt {
            info["refreshTokenExpiresAt"] = expiresAt
            info["refreshTokenExpired"] = now >= expiresAt
        }
        if let refreshAfter {
            info["refreshAfter"] = refreshAfter
            info["refreshOverdue"] = now >= refreshAfter
        }

        if let guardianId = ActorTokenManager.getGuardianPrincipalId() {
            info["guardianPrincipalId"] = guardianId
        }

        // Include lockfile assistant metadata for cross-referencing
        let assistants = LockfileAssistant.loadAll()
        info["lockfileAssistantCount"] = assistants.count
        if !assistants.isEmpty {
            info["lockfileAssistants"] = assistants.map { entry -> [String: Any] in
                var dict: [String: Any] = [
                    "assistantId": entry.assistantId,
                    "cloud": entry.cloud,
                    "isManaged": entry.isManaged,
                    "isRemote": entry.isRemote,
                ]
                if let hatchedAt = entry.hatchedAt { dict["hatchedAt"] = hatchedAt }
                if let gatewayPort = entry.gatewayPort { dict["gatewayPort"] = gatewayPort }
                // Include runtimeUrl presence (not the value, which may contain tokens)
                dict["hasRuntimeUrl"] = entry.runtimeUrl != nil
                dict["hasBearerToken"] = entry.bearerToken != nil
                return dict
            }
        }

        guard let data = try? JSONSerialization.data(
            withJSONObject: info,
            options: [.prettyPrinted, .sortedKeys]
        ) else { return }
        try? data.write(to: url)
    }

    /// Replaces a value with a presence flag: "(set)" if non-empty, "(empty)" otherwise.
    private nonisolated static func redactValue(_ val: Any?) -> String {
        if let str = val as? String { return str.isEmpty ? "(empty)" : "(set)" }
        return val == nil ? "(empty)" : "(set)"
    }

    /// Fetches the workspace config from the daemon and writes a sanitized copy
    /// with sensitive values replaced by presence flags.
    private nonisolated static func writeSanitizedWorkspaceConfig(to url: URL) async {
        var config = await SettingsClient().fetchConfig() ?? [:]
        guard !config.isEmpty else { return }

        // Strip API key values — preserve which providers have keys configured
        if var apiKeys = config["apiKeys"] as? [String: Any] {
            for key in apiKeys.keys {
                apiKeys[key] = redactValue(apiKeys[key])
            }
            config["apiKeys"] = apiKeys
        }

        // Strip ingress webhook secret
        if var ingress = config["ingress"] as? [String: Any],
           var webhook = ingress["webhook"] as? [String: Any] {
            webhook["secret"] = redactValue(webhook["secret"])
            ingress["webhook"] = webhook
            config["ingress"] = ingress
        }

        // Strip skill-level API keys and env vars
        if var skills = config["skills"] as? [String: Any],
           var entries = skills["entries"] as? [String: [String: Any]] {
            for name in entries.keys {
                var entry = entries[name]!
                if entry["apiKey"] != nil {
                    entry["apiKey"] = redactValue(entry["apiKey"])
                }
                if var env = entry["env"] as? [String: Any] {
                    for envKey in env.keys {
                        env[envKey] = redactValue(env[envKey])
                    }
                    entry["env"] = env
                }
                entries[name] = entry
            }
            skills["entries"] = entries
            config["skills"] = skills
        }

        // Strip Twilio accountSid
        if var twilio = config["twilio"] as? [String: Any] {
            twilio["accountSid"] = redactValue(twilio["accountSid"])
            config["twilio"] = twilio
        }

        // Strip MCP transport headers (SSE/streamable-http) and env vars (stdio)
        if var mcp = config["mcp"] as? [String: Any],
           var servers = mcp["servers"] as? [String: [String: Any]] {
            for name in servers.keys {
                var server = servers[name]!
                if var transport = server["transport"] as? [String: Any] {
                    if var headers = transport["headers"] as? [String: Any] {
                        for key in headers.keys {
                            headers[key] = redactValue(headers[key])
                        }
                        transport["headers"] = headers
                    }
                    if var env = transport["env"] as? [String: Any] {
                        for key in env.keys {
                            env[key] = redactValue(env[key])
                        }
                        transport["env"] = env
                    }
                    server["transport"] = transport
                }
                servers[name] = server
            }
            mcp["servers"] = servers
            config["mcp"] = mcp
        }

        guard let data = try? JSONSerialization.data(
            withJSONObject: config,
            options: [.prettyPrinted, .sortedKeys]
        ) else { return }
        try? data.write(to: url)
    }

    /// Writes a human-readable error log file for a failed export API call.
    ///
    /// Supports two failure shapes:
    /// - **HTTP error**: non-2xx `statusCode` with a `responseData` body.
    /// - **Transport error**: a thrown Swift `Error` (timeout, DNS, etc.).
    ///
    /// An optional `note` can provide additional context (e.g. "No session token").
    private nonisolated static func writeExportErrorLog(
        to url: URL,
        source: String,
        statusCode: Int? = nil,
        responseData: Data? = nil,
        error: Error? = nil,
        note: String? = nil
    ) {
        let timestamp = Date().iso8601String
        var lines: [String] = [
            "source: \(source)",
            "timestamp: \(timestamp)",
        ]

        if let note {
            lines.append("note: \(note)")
        }

        if let statusCode {
            lines.append("status_code: \(statusCode)")
        }

        if let error {
            lines.append("error_type: \(String(describing: type(of: error)))")
            lines.append("error_description: \(error.localizedDescription)")
        }

        if let responseData {
            let body = String(data: responseData, encoding: .utf8)
                ?? "<\(responseData.count) bytes, non-UTF-8>"
            lines.append("")
            lines.append("--- response body ---")
            lines.append(body)
        }

        let content = lines.joined(separator: "\n")
        try? content.write(to: url, atomically: true, encoding: .utf8)
    }

    // MARK: - Upload Retry Helpers

    /// Removes the largest item from the staging directory, updates the
    /// `removed-items.log`, and rebuilds the tar archive — all off the main
    /// actor so the UI stays responsive during retries.
    ///
    /// Returns the description of the removed item, or `nil` if nothing
    /// was left to remove.
    private nonisolated static func trimStagingAndRebuildArchive(
        stagingDir: URL,
        archiveURL: URL,
        previouslyRemoved: [String]
    ) async throws -> String? {
        let fileManager = FileManager.default

        guard let removed = removeLargestItem(in: stagingDir, fileManager: fileManager) else {
            return nil
        }

        var allRemoved = previouslyRemoved
        allRemoved.append(removed)

        writeRemovedItemsLog(
            to: stagingDir.appendingPathComponent("removed-items.log"),
            removedItems: allRemoved
        )

        try? fileManager.removeItem(at: archiveURL)
        try await createTarArchive(from: stagingDir, destination: archiveURL)

        return removed
    }

    /// Finds the largest file or directory (by total size) in `directory`,
    /// removes it, and returns its name. Returns `nil` if the directory is
    /// empty or only contains protected files.
    private nonisolated static func removeLargestItem(
        in directory: URL,
        fileManager: FileManager
    ) -> String? {
        guard let contents = try? fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.totalFileAllocatedSizeKey, .isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else { return nil }

        // Protect bookkeeping and essential metadata files from removal
        let protectedNames: Set<String> = ["removed-items.log", "report-metadata.json"]
        let candidates = contents.filter { !protectedNames.contains($0.lastPathComponent) }
        guard !candidates.isEmpty else { return nil }

        let largest = candidates.max { a, b in
            totalSize(of: a, fileManager: fileManager) < totalSize(of: b, fileManager: fileManager)
        }

        guard let target = largest else { return nil }
        let name = target.lastPathComponent
        let size = totalSize(of: target, fileManager: fileManager)
        do {
            try fileManager.removeItem(at: target)
        } catch {
            log.warning("Failed to remove \(name) from staging directory: \(error.localizedDescription)")
            return nil
        }
        log.info("Removed \(name) (\(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))) from staging directory")
        return "\(name) (\(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)))"
    }

    /// Returns the total size in bytes of a file or directory (recursive).
    private nonisolated static func totalSize(of url: URL, fileManager: FileManager) -> Int {
        let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .totalFileAllocatedSizeKey])
        if values?.isDirectory == true {
            guard let enumerator = fileManager.enumerator(
                at: url,
                includingPropertiesForKeys: [.totalFileAllocatedSizeKey],
                options: [.skipsHiddenFiles]
            ) else { return 0 }
            var total = 0
            for case let fileURL as URL in enumerator {
                let fileValues = try? fileURL.resourceValues(forKeys: [.totalFileAllocatedSizeKey])
                total += fileValues?.totalFileAllocatedSize ?? 0
            }
            return total
        }
        return values?.totalFileAllocatedSize ?? 0
    }

    /// Writes (or overwrites) the `removed-items.log` file listing all items
    /// that were stripped from the archive to reduce its size.
    private nonisolated static func writeRemovedItemsLog(
        to url: URL,
        removedItems: [String]
    ) {
        var lines = [
            "The following items were removed from this feedback archive because",
            "the upload exceeded the server's maximum request size (HTTP 413).",
            "Items are listed in removal order (largest first per iteration).",
            "",
        ]
        for (index, item) in removedItems.enumerated() {
            lines.append("\(index + 1). \(item)")
        }
        let content = lines.joined(separator: "\n")
        try? content.write(to: url, atomically: true, encoding: .utf8)
    }

    enum ExportError: LocalizedError {
        case noLogsFound
        case tarFailed(String)
        case unsafeArchivePath(String)
        case requestTooLarge

        var errorDescription: String? {
            switch self {
            case .noLogsFound:
                return "No log files were found to export."
            case .tarFailed(let detail):
                return "Failed to create archive: \(detail)"
            case .unsafeArchivePath(let path):
                return "Archive contains unsafe path: \(path)"
            case .requestTooLarge:
                return "Feedback archive is too large to upload even after removing the largest files."
            }
        }
    }
}
