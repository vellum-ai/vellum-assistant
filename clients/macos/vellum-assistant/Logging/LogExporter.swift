import AppKit
import Foundation
import os
@preconcurrency import Sentry
import VellumAssistantShared

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "LogExporter"
)

/// Collects all assistant log sources into a single `.tar.gz` archive
/// that users can share with support for debugging.
///
/// Log sources included:
/// - `~/Library/Application Support/vellum-assistant/logs/`  — per-session JSON logs
/// - `~/Library/Application Support/vellum-assistant/debug-state.json` — live debug snapshot (includes session error debug details)
/// - Daemon logs, audit data, and sanitized config via `POST /v1/export` gateway HTTP API
/// - `~/.config/vellum/logs/` — CLI XDG logs (hatch.log, retire.log, etc.)
/// - `~/.vellum.lock.json` — sanitized lockfile with assistant entries and resource ports (credentials stripped)
/// - `user-defaults.json` — snapshot of app-relevant UserDefaults keys
/// - `auth-debug.json` — non-sensitive token expiry and refresh state for session debugging
/// - `port-diagnostics.json` — processes listening on assistant-relevant TCP ports
/// - `config-snapshot.json` — sanitized workspace config (API key values redacted, structure preserved)
@MainActor
enum LogExporter {

    /// Collects logs, archives them, and sends to Sentry as an attachment for developer debugging.
    /// Includes report metadata (reason, message) from the log report form.
    static func sendLogsToSentry(formData: LogReportFormData) {
        Task {
            let fileManager = FileManager.default
            let archiveURL = fileManager.temporaryDirectory
                .appendingPathComponent("vellum-assistant-logs-\(UUID().uuidString).tar.gz")

            do {
                try await buildArchive(destination: archiveURL, formData: formData)
            } catch {
                log.error("Failed to build log archive for Sentry: \(error.localizedDescription)")
                NSApp.activate(ignoringOtherApps: true)
                let alert = NSAlert()
                alert.messageText = "Send Failed"
                alert.informativeText = "Could not collect logs: \(error.localizedDescription)"
                alert.alertStyle = .warning
                alert.runModal()
                return
            }

            let archiveName = defaultArchiveName()
            let attachment = Attachment(path: archiveURL.path, filename: archiveName)
            let event = Event(level: .info)
            let errorTitle = "\(formData.reason.displayName) log report"
            event.message = SentryMessage(formatted: errorTitle)
            // Set error so Sentry displays the error message (not "No error message provided").
            event.error = NSError(
                domain: "com.vellum.log-report",
                code: 0,
                userInfo: [NSLocalizedDescriptionKey: errorTitle]
            )
            var tags: [String: String] = [
                "source": "log_report",
                "report_reason": formData.reason.rawValue,
            ]
            // When routing to the brain project, tag the event so it's clear
            // it originated from the macOS client (not the daemon itself).
            if formData.reason == .assistantBehavior {
                tags["client"] = "macos"
            }
            event.tags = tags
            // Group all reports by reason so different user messages don't
            // fragment into separate Sentry issues.
            event.fingerprint = ["log_report", formData.reason.rawValue]

            // User-provided context (message, email, category) is sent via
            // Sentry's UserFeedback API, linked to the event. This keeps PII
            // out of event tags/extras and lets us use Sentry's built-in
            // feedback UI for triage.
            let feedback = MetricKitManager.UserFeedbackData(
                comments: formData.message.isEmpty ? nil : formData.message,
                email: formData.email,
                name: formData.name.isEmpty ? nil : formData.name
            )

            // Route assistant behavior reports to the brain Sentry project
            // so they appear alongside daemon issues for triage.
            let dsn: String? = formData.reason == .assistantBehavior
                ? MetricKitManager.brainDSN
                : nil

            await withCheckedContinuation { continuation in
                MetricKitManager.sendManualReport(
                    event,
                    attachments: [attachment],
                    userFeedback: feedback,
                    dsn: dsn
                ) {
                    try? FileManager.default.removeItem(at: archiveURL)
                    continuation.resume()
                }
            }

            // Re-activate before showing the alert in case the app reverted
            // to .accessory policy after the log report window was dismissed.
            NSApp.activate(ignoringOtherApps: true)
            let alert = NSAlert()
            alert.messageText = "Log Sent"
            alert.informativeText = "Your log report has been sent to Vellum."
            alert.alertStyle = .informational
            alert.runModal()
        }
    }

    // MARK: - Private

    private static func defaultArchiveName() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withFullDate, .withTime, .withColonSeparatorInTime]
        let timestamp = formatter.string(from: Date())
            .replacingOccurrences(of: ":", with: "-")
        return "vellum-assistant-logs-\(timestamp).tar.gz"
    }

    /// Builds a tar.gz archive containing all discoverable log files.
    /// Runs file I/O and the tar process off the main actor to avoid blocking the UI.
    private nonisolated static func buildArchive(destination: URL, formData: LogReportFormData? = nil) async throws {
        let fileManager = FileManager.default
        let tempDir = fileManager.temporaryDirectory
            .appendingPathComponent("vellum-log-export-\(UUID().uuidString)", isDirectory: true)
        try fileManager.createDirectory(at: tempDir, withIntermediateDirectories: true)

        defer {
            try? fileManager.removeItem(at: tempDir)
        }

        // 1. Session logs — ~/Library/Application Support/vellum-assistant/logs/
        if let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            let sessionLogDir = appSupport.appendingPathComponent("vellum-assistant/logs", isDirectory: true)
            copyDirectoryContents(
                from: sessionLogDir,
                to: tempDir.appendingPathComponent("session-logs", isDirectory: true),
                fileManager: fileManager
            )

            // 2. Debug state snapshot
            let debugState = appSupport.appendingPathComponent("vellum-assistant/debug-state.json")
            if fileManager.fileExists(atPath: debugState.path) {
                try? fileManager.copyItem(
                    at: debugState,
                    to: tempDir.appendingPathComponent("debug-state.json")
                )
            }
        }

        // 3. Assistant logs — platform API for managed, local gateway for self-hosted
        let home = NSHomeDirectory()
        let connectedId = UserDefaults.standard.string(forKey: "connectedAssistantId")
        let isManagedAssistant: Bool = {
            guard let id = connectedId else { return false }
            return LockfileAssistant.loadByName(id)?.isManaged == true
        }()

        if isManagedAssistant, let assistantId = connectedId,
           let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId") {
            await fetchPlatformLogs(into: tempDir, assistantId: assistantId, organizationId: orgId)
        } else {
            await fetchDaemonExports(into: tempDir)
        }

        // 4. XDG CLI logs — ~/.config/vellum/logs/ (hatch.log, retire.log, etc.)
        let xdgConfigHome = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"]
            ?? URL(fileURLWithPath: home).appendingPathComponent(".config").path
        let xdgLogDir = URL(fileURLWithPath: xdgConfigHome)
            .appendingPathComponent("vellum/logs", isDirectory: true)
        copyDirectoryContents(
            from: xdgLogDir,
            to: tempDir.appendingPathComponent("xdg-logs", isDirectory: true),
            fileManager: fileManager
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

        // 9. Report metadata — reason and message from the log report form.
        // Email is excluded from the archive since it's already sent via
        // Sentry's UserFeedback API (linked to the event).
        if let formData {
            var metadata: [String: String] = [
                "reason": formData.reason.rawValue,
                "message": formData.message,
                "device_id": SentryDeviceInfo.deviceId,
            ]
            if !formData.name.isEmpty {
                metadata["name"] = formData.name
            }
            if let data = try? JSONSerialization.data(
                withJSONObject: metadata,
                options: [.prettyPrinted, .sortedKeys]
            ) {
                try? data.write(to: tempDir.appendingPathComponent("report-metadata.json"))
            }
        }

        // 10. Sanitized workspace config — client-side fallback if daemon export didn't include it
        let configSnapshotPath = tempDir.appendingPathComponent("config-snapshot.json")
        if !fileManager.fileExists(atPath: configSnapshotPath.path) {
            writeSanitizedWorkspaceConfig(to: configSnapshotPath)
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

        // Create tar.gz using /usr/bin/tar
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
            process.arguments = [
                "czf",
                destination.path,
                "-C", tempDir.path,
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

    /// Copies all files from `source` into `dest`, creating `dest` if needed.
    /// Silently skips if `source` doesn't exist or is empty.
    private nonisolated static func copyDirectoryContents(
        from source: URL,
        to dest: URL,
        fileManager: FileManager
    ) {
        guard fileManager.fileExists(atPath: source.path) else { return }
        guard let items = try? fileManager.contentsOfDirectory(
            at: source,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ), !items.isEmpty else { return }

        try? fileManager.createDirectory(at: dest, withIntermediateDirectories: true)
        for item in items {
            try? fileManager.copyItem(
                at: item,
                to: dest.appendingPathComponent(item.lastPathComponent)
            )
        }
    }

    // MARK: - Daemon HTTP Helpers

    /// Calls POST /v1/export on the gateway to fetch audit data and daemon
    /// log files, then writes them into `directory`. Silently skips if the
    /// gateway is unreachable or returns an error.
    private nonisolated static func fetchDaemonExports(into directory: URL) async {
        let baseURL = LockfilePaths.resolveGatewayUrl()

        guard let token = ActorTokenManager.getToken(), !token.isEmpty else {
            log.warning("No actor token available — skipping daemon exports")
            return
        }

        guard let url = URL(string: "\(baseURL)/v1/export") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["auditLimit": 10000])

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200...299).contains(http.statusCode) else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? -1
                log.warning("Export API failed with status \(status)")
                return
            }

            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                log.warning("Export API returned unexpected format")
                return
            }

            // Write audit rows as a standalone JSON file
            if let auditRows = json["auditRows"] {
                if let auditData = try? JSONSerialization.data(
                    withJSONObject: auditRows,
                    options: [.prettyPrinted]
                ) {
                    try? auditData.write(to: directory.appendingPathComponent("audit-data.json"))
                }
            }

            // Write each daemon log file into a daemon-logs/ subdirectory
            if let logFiles = json["logFiles"] as? [String: String] {
                let logsDir = directory.appendingPathComponent("daemon-logs", isDirectory: true)
                try? FileManager.default.createDirectory(at: logsDir, withIntermediateDirectories: true)
                for (filename, content) in logFiles {
                    let sanitized = (filename as NSString).lastPathComponent
                    try? content.write(
                        to: logsDir.appendingPathComponent(sanitized),
                        atomically: true,
                        encoding: .utf8
                    )
                }
            }

            // Write sanitized config snapshot from the daemon
            if let configSnapshot = json["configSnapshot"] {
                if let configData = try? JSONSerialization.data(
                    withJSONObject: configSnapshot,
                    options: [.prettyPrinted, .sortedKeys]
                ) {
                    try? configData.write(to: directory.appendingPathComponent("config-snapshot.json"))
                }
            }
        } catch {
            log.warning("Export API request failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Platform Log Helpers

    /// Fetches logs from the platform API for managed assistants, downloads
    /// the tar.gz response, extracts it into `directory/platform-logs/`.
    /// Silently skips on any failure (non-fatal, mirrors `fetchDaemonExports`).
    private nonisolated static func fetchPlatformLogs(
        into directory: URL,
        assistantId: String,
        organizationId: String
    ) async {
        guard let token = SessionTokenManager.getToken() else {
            log.warning("No session token available — skipping platform log export")
            return
        }

        let baseURL = await MainActor.run { AuthService.shared.baseURL }

        guard let url = URL(string: "\(baseURL)/v1/assistants/\(assistantId)/logs/export/") else {
            log.warning("Failed to construct platform log export URL")
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
                return
            }

            let fileManager = FileManager.default
            let tarPath = fileManager.temporaryDirectory
                .appendingPathComponent("platform-logs-\(UUID().uuidString).tar.gz")
            try data.write(to: tarPath)

            defer {
                try? fileManager.removeItem(at: tarPath)
            }

            let extractDir = directory.appendingPathComponent("platform-logs", isDirectory: true)
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
        } catch {
            log.warning("Platform log export request failed: \(error.localizedDescription)")
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
            "connectedAssistantId",
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
            "conversationTextZoomLevel",
            "collectUsageDataEnabled",
            "sendPerformanceReports",
            "ttsVoiceId",
            "selectedImageGenModel",
            "activityNotificationsEnabled",
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
            "exportedAt": ISO8601DateFormatter().string(from: Date()),
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
                if let daemonPort = entry.daemonPort { dict["daemonPort"] = daemonPort }
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

    /// Reads the workspace config.json and writes a sanitized copy with API key
    /// values replaced by presence flags. Falls back silently if unreadable.
    private nonisolated static func writeSanitizedWorkspaceConfig(to url: URL) {
        var config = WorkspaceConfigIO.read()
        guard !config.isEmpty else { return }

        // Strip API key values — preserve which providers have keys configured
        if var apiKeys = config["apiKeys"] as? [String: Any] {
            for key in apiKeys.keys {
                apiKeys[key] = apiKeys[key] != nil ? "(set)" : "(empty)"
            }
            config["apiKeys"] = apiKeys
        }

        guard let data = try? JSONSerialization.data(
            withJSONObject: config,
            options: [.prettyPrinted, .sortedKeys]
        ) else { return }
        try? data.write(to: url)
    }

    enum ExportError: LocalizedError {
        case noLogsFound
        case tarFailed(String)

        var errorDescription: String? {
            switch self {
            case .noLogsFound:
                return "No log files were found to export."
            case .tarFailed(let detail):
                return "Failed to create archive: \(detail)"
            }
        }
    }
}
