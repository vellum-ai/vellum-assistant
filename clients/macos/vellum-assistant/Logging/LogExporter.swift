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
/// - Workspace files via `POST /v1/export` — full workspace contents (config, skills, prompts, hooks, DB dump, logs)
/// - `~/.config/vellum/logs/` — CLI XDG logs (hatch.log, retire.log, etc.)
/// - `~/.vellum.lock.json` — sanitized lockfile with assistant entries and resource ports (credentials stripped)
/// - `user-defaults.json` — snapshot of app-relevant UserDefaults keys
/// - `auth-debug.json` — non-sensitive token expiry and refresh state for session debugging
/// - `port-diagnostics.json` — processes listening on assistant-relevant TCP ports
/// - `config-snapshot.json` — sanitized workspace config (API key values redacted, structure preserved)
@MainActor
enum LogExporter {

    /// Whether the currently connected assistant is a managed (platform-hosted) instance.
    /// When true, thread-scoped exports are not available because the platform API
    /// does not yet support conversation-scoped log retrieval.
    nonisolated static var isManagedAssistant: Bool {
        guard let id = UserDefaults.standard.string(forKey: "connectedAssistantId") else { return false }
        return LockfileAssistant.loadByName(id)?.isManaged == true
    }

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
            let errorTitle: String
            switch formData.scope {
            case .thread(_, let threadTitle, _, _):
                errorTitle = "\(formData.reason.displayName) log report (thread: \(threadTitle))"
            case .global:
                errorTitle = "\(formData.reason.displayName) log report"
            }
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
            if case .thread(let conversationId, _, _, _) = formData.scope {
                tags["conversation_id"] = conversationId
                tags["export_scope"] = "thread"
            } else {
                tags["export_scope"] = "global"
            }
            // When routing to the brain project, tag the event so it's clear
            // it originated from the macOS client (not the daemon itself).
            if formData.reason == .assistantBehavior {
                tags["client"] = "macos"
            }

            // Surface active session state as tags so the Sentry event itself
            // is useful for triage without downloading the log archive.
            var extra: [String: Any] = [:]
            let threadManager = AppDelegate.shared?.mainWindow?.threadManager
            if let activeThread = threadManager?.activeThread {
                extra["thread_title"] = activeThread.title
                if let sessionId = activeThread.sessionId {
                    tags["session_id"] = sessionId
                    // conversation_id mirrors session_id — the daemon tags its
                    // Sentry events with both names for the same value. Setting
                    // it here enables cross-project search: find the daemon error
                    // that corresponds to a macOS log report by querying
                    // conversation_id in the vellum-assistant-brain Sentry project.
                    // For thread-scoped exports, conversation_id was already set
                    // to the reported thread's ID above — don't overwrite it with
                    // the active thread's session ID.
                    if case .global = formData.scope {
                        tags["conversation_id"] = sessionId
                    }
                }
            }
            var errorCategoryString: String?
            if let vm = threadManager?.activeViewModel {
                extra["message_count"] = vm.messages.count
                if let sessionError = vm.sessionError {
                    let category = "\(sessionError.category)"
                    tags["session_error_category"] = category
                    errorCategoryString = category
                    if let debugDetails = sessionError.debugDetails {
                        extra["session_error_debug_details"] = debugDetails
                    }
                }
                if let sessionId = vm.sessionId {
                    // Prefer the view model's sessionId (most up-to-date)
                    tags["session_id"] = sessionId
                    // For thread-scoped exports, conversation_id reflects the
                    // reported thread, not the active one — skip the overwrite.
                    if case .global = formData.scope {
                        tags["conversation_id"] = sessionId
                    }
                }
            }
            if let assistantId = UserDefaults.standard.string(forKey: "connectedAssistantId") {
                tags["assistant_id"] = assistantId
            }
            if !extra.isEmpty {
                event.extra = extra
            }

            event.tags = tags
            // Group reports by reason and error category so different root
            // causes (e.g. providerApi vs contextTooLarge) create separate
            // Sentry issues instead of being mixed into one.
            let categoryComponent = errorCategoryString ?? "none"
            event.fingerprint = ["log_report", formData.reason.rawValue, categoryComponent]

            // User-provided context (message, email, category) is sent via
            // Sentry's Feedback API, linked to the event. This keeps PII
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
        let isManagedAssistant = Self.isManagedAssistant

        if isManagedAssistant, let assistantId = connectedId,
           let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId") {
            await fetchPlatformLogs(into: tempDir, assistantId: assistantId, organizationId: orgId)
        } else {
            await fetchDaemonExports(into: tempDir, scope: formData?.scope ?? .global)
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
        // Sentry's Feedback API (linked to the event).
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

        // 10. Sanitized workspace config — client-side fallback if daemon export didn't include it.
        //     The daemon archive extracts into daemon-exports/, so check both locations.
        let configSnapshotPath = tempDir.appendingPathComponent("config-snapshot.json")
        let daemonConfigPath = tempDir.appendingPathComponent("daemon-exports/config-snapshot.json")
        if !fileManager.fileExists(atPath: configSnapshotPath.path)
            && !fileManager.fileExists(atPath: daemonConfigPath.path) {
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

    /// Calls POST /v1/export on the gateway to download a tar.gz archive of
    /// audit data, daemon logs, workspace files, and config snapshot.
    /// Extracts the archive into `directory/daemon-exports/`.
    /// Silently skips if the gateway is unreachable or returns an error.
    private nonisolated static func fetchDaemonExports(into directory: URL, scope: LogExportScope) async {
        let connectedId = UserDefaults.standard.string(forKey: "connectedAssistantId")
        let baseURL = LockfilePaths.resolveGatewayUrl(connectedAssistantId: connectedId)

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

        var body: [String: Any] = ["auditLimit": 10000]
        if case .thread(let conversationId, _, let startTime, let endTime) = scope {
            body["conversationId"] = conversationId
            if let startTime {
                body["startTime"] = Int(startTime.timeIntervalSince1970 * 1000)
            }
            if let endTime {
                body["endTime"] = Int(endTime.timeIntervalSince1970 * 1000)
            }
        }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200...299).contains(http.statusCode) else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? -1
                log.warning("Export API failed with status \(status)")
                return
            }

            try await extractTarGzResponse(data: data, into: directory, subdirectory: "daemon-exports")
        } catch {
            log.warning("Export API request failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Platform Log Helpers

    /// Fetches logs from the platform API for managed assistants, downloads
    /// the tar.gz response, extracts it into `directory/platform-logs/`.
    /// Silently skips on any failure.
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

            try await extractTarGzResponse(data: data, into: directory, subdirectory: "platform-logs")
        } catch {
            log.warning("Platform log export request failed: \(error.localizedDescription)")
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

    /// Replaces a value with a presence flag: "(set)" if non-empty, "(empty)" otherwise.
    private nonisolated static func redactValue(_ val: Any?) -> String {
        if let str = val as? String { return str.isEmpty ? "(empty)" : "(set)" }
        return val == nil ? "(empty)" : "(set)"
    }

    /// Reads the workspace config.json and writes a sanitized copy with sensitive
    /// values replaced by presence flags. Falls back silently if unreadable.
    private nonisolated static func writeSanitizedWorkspaceConfig(to url: URL) {
        var config = WorkspaceConfigIO.read()
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

    enum ExportError: LocalizedError {
        case noLogsFound
        case tarFailed(String)
        case unsafeArchivePath(String)

        var errorDescription: String? {
            switch self {
            case .noLogsFound:
                return "No log files were found to export."
            case .tarFailed(let detail):
                return "Failed to create archive: \(detail)"
            case .unsafeArchivePath(let path):
                return "Archive contains unsafe path: \(path)"
            }
        }
    }
}
