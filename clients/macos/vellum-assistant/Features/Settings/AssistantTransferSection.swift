import Foundation
import os
import SwiftUI
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AssistantTransfer")

/// Transfer UI for moving an assistant between local and cloud (managed) hosting.
///
/// For local assistants, offers "Transfer to Cloud" which exports a `.vbundle`,
/// creates/discovers a managed assistant on the platform, imports the bundle,
/// switches the active connection, and retires the local assistant.
///
/// For managed assistants, offers "Transfer to Local" which initiates an async
/// platform export, polls for completion, downloads the bundle, ensures a local
/// assistant exists, imports the bundle, switches, and retires the managed one.
@MainActor
struct AssistantTransferSection: View {
    let assistant: LockfileAssistant
    let onClose: () -> Void

    @State private var isTransferring = false
    @State private var currentStep: String?
    @State private var showingConfirmation = false
    @State private var showingManagedConfirmation = false
    @State private var errorMessage: String?
    @State private var transferTask: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Transfer")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.contentDefault)

            if !assistant.isManaged && !assistant.isRemote {
                localToManagedContent
            } else if assistant.isManaged {
                managedToLocalContent
            } else {
                EmptyView()
            }

            if isTransferring {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text(currentStep ?? "Transferring...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
            }

            if let error = errorMessage {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.systemNegativeStrong)
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceOverlay)
        .alert("Transfer to Cloud", isPresented: $showingConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Transfer", role: .destructive) {
                transferTask = Task { await transferLocalToManaged() }
            }
        } message: {
            Text("This will move all conversations, memory, and settings to a cloud-hosted assistant, then retire the local one. This cannot be undone.")
        }
        .alert("Transfer to Local", isPresented: $showingManagedConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Transfer", role: .destructive) {
                transferTask = Task { await transferManagedToLocal() }
            }
        } message: {
            Text("This will move all conversations, memory, and settings to a local assistant on this Mac, then retire the cloud one. This cannot be undone.")
        }
        .onDisappear {
            transferTask?.cancel()
        }
    }

    // MARK: - Local → Managed Content

    @ViewBuilder
    private var localToManagedContent: some View {
        Text("Move your assistant and all its data to the cloud.")
            .font(VFont.caption)
            .foregroundColor(VColor.contentTertiary)

        VButton(
            label: isTransferring ? "Transferring..." : "Transfer to Cloud",
            style: .primary,
            isDisabled: isTransferring || SessionTokenManager.getToken() == nil
        ) {
            showingConfirmation = true
        }

        if SessionTokenManager.getToken() == nil {
            Text("Sign in to transfer your assistant to the cloud.")
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
        }
    }

    // MARK: - Managed → Local Content

    @ViewBuilder
    private var managedToLocalContent: some View {
        Text("Move your assistant and all its data to this Mac.")
            .font(VFont.caption)
            .foregroundColor(VColor.contentTertiary)

        VButton(
            label: isTransferring ? "Transferring..." : "Transfer to Local",
            style: .primary,
            isDisabled: isTransferring
        ) {
            showingManagedConfirmation = true
        }
    }

    // MARK: - Transfer Logic

    private func transferLocalToManaged() async {
        isTransferring = true
        errorMessage = nil
        defer {
            isTransferring = false
            currentStep = nil
        }

        do {
            // Step 1 — Export local assistant data
            currentStep = "Exporting assistant data..."
            let bundleData = try await exportAssistantBundle()

            // Step 2 — Ensure managed assistant exists on platform
            currentStep = "Setting up cloud assistant..."
            let outcome = try await ManagedAssistantBootstrapService.shared.ensureManagedAssistant()
            let platformAssistant: PlatformAssistant
            switch outcome {
            case .reusedExisting(let assistant):
                platformAssistant = assistant
            case .createdNew(let assistant):
                platformAssistant = assistant
            }
            let lockfileSuccess = LockfileAssistant.upsertManagedEntry(
                assistantId: platformAssistant.id,
                runtimeUrl: AuthService.shared.baseURL,
                hatchedAt: platformAssistant.created_at ?? ISO8601DateFormatter().string(from: Date())
            )
            guard lockfileSuccess else {
                throw TransferError.importFailed(message: "Failed to save managed assistant configuration to lockfile.")
            }

            // Step 3 — Import bundle to managed assistant
            currentStep = "Importing data to cloud..."
            try await importBundleToManaged(bundleData: bundleData)

            // Step 4 — Switch to managed assistant
            currentStep = "Switching to cloud assistant..."
            guard let managedAssistant = LockfileAssistant.loadAll().first(where: { $0.assistantId == platformAssistant.id && $0.isManaged }) else {
                throw TransferError.managedEntryNotFound
            }
            AppDelegate.shared?.performSwitchAssistant(to: managedAssistant)
            transferTask = nil
            onClose()

            // Step 5 — Retire local assistant (fire-and-forget)
            currentStep = "Cleaning up..."
            let localName = assistant.assistantId
            do {
                try await AppDelegate.shared?.assistantCli.retire(name: localName)
            } catch {
                log.error("[transfer] Failed to retire local assistant \(localName, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
        } catch {
            errorMessage = "Transfer failed: \(error.localizedDescription)"
        }
    }

    // MARK: - Managed → Local Transfer Logic

    private func transferManagedToLocal() async {
        isTransferring = true
        errorMessage = nil
        defer {
            isTransferring = false
            currentStep = nil
        }

        // Pre-save auth credentials before any switching
        let savedSessionToken = SessionTokenManager.getToken()
        let savedOrgId = UserDefaults.standard.string(forKey: "connectedOrganizationId")
        let savedPlatformUrl = AuthService.shared.baseURL
        let managedAssistantId = assistant.assistantId

        do {
            // Step 1 — Initiate export
            currentStep = "Requesting cloud export..."
            let exportResponse = try await GatewayHTTPClient.post(path: "migrations/export")
            guard exportResponse.isSuccess else {
                throw TransferError.exportFailed(statusCode: exportResponse.statusCode)
            }
            guard let exportJson = try? JSONSerialization.jsonObject(with: exportResponse.data) as? [String: Any],
                  let jobId = exportJson["job_id"] as? String else {
                throw TransferError.exportFailed(statusCode: 0)
            }

            // Step 2 — Poll for completion (up to 5 minutes)
            currentStep = "Waiting for export..."
            var downloadUrl: String?
            for _ in 0..<100 {
                try Task.checkCancellation()
                let statusResponse = try await GatewayHTTPClient.get(path: "migrations/export/\(jobId)/status")
                guard statusResponse.isSuccess,
                      let statusJson = try? JSONSerialization.jsonObject(with: statusResponse.data) as? [String: Any],
                      let status = statusJson["status"] as? String else {
                    throw TransferError.exportFailed(statusCode: statusResponse.statusCode)
                }

                if status == "complete" {
                    guard let url = statusJson["download_url"] as? String else {
                        throw TransferError.exportFailed(statusCode: 0)
                    }
                    downloadUrl = url
                    break
                } else if status == "failed" {
                    let errorMsg = (statusJson["error"] as? String) ?? "Export job failed"
                    throw TransferError.importFailed(message: errorMsg)
                } else if status == "pending" || status == "processing" {
                    try await Task.sleep(nanoseconds: 3_000_000_000)
                } else {
                    throw TransferError.exportFailed(statusCode: 0)
                }
            }

            guard let finalDownloadUrl = downloadUrl else {
                throw TransferError.exportTimedOut
            }

            // Step 3 — Download bundle
            currentStep = "Downloading assistant data..."
            guard let bundleURL = URL(string: finalDownloadUrl) else {
                throw TransferError.invalidURL
            }
            let (bundleData, dlResponse) = try await URLSession.shared.data(from: bundleURL)
            guard let httpDlResponse = dlResponse as? HTTPURLResponse, httpDlResponse.statusCode == 200 else {
                let statusCode = (dlResponse as? HTTPURLResponse)?.statusCode ?? 0
                throw TransferError.exportFailed(statusCode: statusCode)
            }

            // Step 4 — Ensure local assistant exists and its daemon is running
            currentStep = "Preparing local assistant..."
            var localAssistant = LockfileAssistant.loadAll().first(where: { !$0.isRemote && !$0.isManaged })
            if localAssistant == nil {
                try await AppDelegate.shared?.assistantCli.hatch()
                localAssistant = LockfileAssistant.loadAll().first(where: { !$0.isRemote && !$0.isManaged })
            } else {
                // Existing local assistant may be sleeping — wake it before health check
                try await AppDelegate.shared?.assistantCli.wake(name: localAssistant!.assistantId)
            }
            guard let resolvedLocal = localAssistant else {
                throw TransferError.localAssistantNotFound
            }

            // Wait for daemon readiness (up to 30s)
            let daemonPort = resolvedLocal.resolvedDaemonPort()
            let healthURL = URL(string: "http://localhost:\(daemonPort)/healthz")!
            for i in 0..<30 {
                if let (_, healthResp) = try? await URLSession.shared.data(from: healthURL),
                   let httpHealth = healthResp as? HTTPURLResponse,
                   httpHealth.statusCode == 200 {
                    break
                }
                if i == 29 {
                    throw TransferError.localAssistantNotFound
                }
                try await Task.sleep(nanoseconds: 1_000_000_000)
            }

            // Step 5 — Bootstrap actor token directly against the local daemon
            // (without calling performSwitchAssistant, which destroys the window)
            currentStep = "Authenticating with local assistant..."
            let actorToken = try await bootstrapActorToken(daemonPort: daemonPort)

            // Step 6 — Import to local
            currentStep = "Importing data..."
            guard let importURL = URL(string: "http://localhost:\(daemonPort)/v1/migrations/import") else {
                throw TransferError.invalidURL
            }
            var importRequest = URLRequest(url: importURL)
            importRequest.httpMethod = "POST"
            importRequest.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            importRequest.setValue("Bearer \(actorToken)", forHTTPHeaderField: "Authorization")
            importRequest.httpBody = bundleData
            importRequest.timeoutInterval = 120

            let (importData, importResponse) = try await URLSession.shared.data(for: importRequest)
            guard let httpImportResponse = importResponse as? HTTPURLResponse,
                  httpImportResponse.statusCode == 200 else {
                let statusCode = (importResponse as? HTTPURLResponse)?.statusCode ?? 0
                throw TransferError.importFailed(message: "HTTP \(statusCode)")
            }
            if let importJson = try? JSONSerialization.jsonObject(with: importData) as? [String: Any],
               let success = importJson["success"] as? Bool, !success {
                let errorMsg = (importJson["error"] as? String) ?? "Import reported failure"
                throw TransferError.importFailed(message: errorMsg)
            }

            // Step 7 — Switch to local assistant now that import succeeded
            AppDelegate.shared?.performSwitchAssistant(to: resolvedLocal)
            transferTask = nil
            onClose()

            // Step 8 — Retire managed assistant (fire-and-forget with pre-saved auth)
            currentStep = "Cleaning up..."
            if let token = savedSessionToken {
                let retireUrlString = "\(savedPlatformUrl)/v1/assistants/\(managedAssistantId)/retire/"
                if let retireURL = URL(string: retireUrlString) {
                    var retireRequest = URLRequest(url: retireURL)
                    retireRequest.httpMethod = "DELETE"
                    retireRequest.timeoutInterval = 30
                    retireRequest.setValue(token, forHTTPHeaderField: "X-Session-Token")
                    if let orgId = savedOrgId {
                        retireRequest.setValue(orgId, forHTTPHeaderField: "Vellum-Organization-Id")
                    }
                    let retireResult = try? await URLSession.shared.data(for: retireRequest)
                    if let (_, retireResponse) = retireResult,
                       let httpRetire = retireResponse as? HTTPURLResponse,
                       (200..<300).contains(httpRetire.statusCode) {
                        log.info("[transfer] Retired managed assistant \(managedAssistantId, privacy: .public)")
                    } else {
                        let statusCode = (retireResult?.1 as? HTTPURLResponse)?.statusCode ?? 0
                        log.error("[transfer] Failed to retire managed assistant \(managedAssistantId, privacy: .public): HTTP \(statusCode, privacy: .public)")
                    }
                }
            } else {
                log.warning("[transfer] Skipping managed assistant retire — no session token available for \(managedAssistantId, privacy: .public)")
            }
        } catch {
            errorMessage = "Transfer failed: \(error.localizedDescription)"
        }
    }

    // MARK: - Local → Managed Transfer Helpers

    /// Exports the local assistant's data as a `.vbundle` binary archive.
    private func exportAssistantBundle() async throws -> Data {
        let port = assistant.resolvedDaemonPort()
        let token = ActorTokenManager.getToken()

        guard let url = URL(string: "http://localhost:\(port)/v1/migrations/export") else {
            throw TransferError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        if let token, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw TransferError.exportFailed(statusCode: statusCode)
        }

        return data
    }

    /// Bootstraps an actor token directly against a local daemon's `/v1/guardian/init`
    /// endpoint without going through `performSwitchAssistant` (which destroys the window).
    /// Retries with exponential backoff up to ~30s.
    private func bootstrapActorToken(daemonPort: Int) async throws -> String {
        let deviceId = PairingQRCodeSheet.computeHostId()
        guard let url = URL(string: "http://localhost:\(daemonPort)/v1/guardian/init") else {
            throw TransferError.invalidURL
        }

        let body: [String: String] = ["platform": "macos", "deviceId": deviceId]
        let bodyData = try JSONSerialization.data(withJSONObject: body)

        var delay: UInt64 = 2_000_000_000
        for attempt in 0..<6 {
            try Task.checkCancellation()
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.timeoutInterval = 15
            request.httpBody = bodyData

            if let (data, response) = try? await URLSession.shared.data(for: request),
               let http = response as? HTTPURLResponse,
               (200..<300).contains(http.statusCode),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let token = json["accessToken"] as? String ?? json["actorToken"] as? String {
                return token
            }

            if attempt < 5 {
                try await Task.sleep(nanoseconds: delay)
                delay = min(delay * 2, 10_000_000_000)
            }
        }

        throw TransferError.notSignedIn
    }

    /// Imports a `.vbundle` archive into the managed assistant via the platform API.
    private func importBundleToManaged(bundleData: Data) async throws {
        guard let sessionToken = SessionTokenManager.getToken() else {
            throw TransferError.notSignedIn
        }

        let baseURL = AuthService.shared.baseURL
        guard let url = URL(string: "\(baseURL)/v1/migrations/import/") else {
            throw TransferError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.setValue(sessionToken, forHTTPHeaderField: "X-Session-Token")
        if let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId") {
            request.setValue(orgId, forHTTPHeaderField: "Vellum-Organization-Id")
        }
        request.httpBody = bundleData

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw TransferError.invalidResponse
        }

        guard httpResponse.statusCode == 200 else {
            // Try to extract error message from response
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let errorMsg = json["error"] as? String {
                throw TransferError.importFailed(message: errorMsg)
            }
            throw TransferError.importFailed(message: "HTTP \(httpResponse.statusCode)")
        }

        // Verify success field in response
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let success = json["success"] as? Bool, !success {
            let errorMsg = (json["error"] as? String) ?? "Import reported failure"
            throw TransferError.importFailed(message: errorMsg)
        }
    }
}

// MARK: - Transfer Errors

private enum TransferError: LocalizedError {
    case invalidURL
    case invalidResponse
    case notSignedIn
    case exportFailed(statusCode: Int)
    case exportTimedOut
    case importFailed(message: String)
    case managedEntryNotFound
    case localAssistantNotFound

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid URL"
        case .invalidResponse:
            return "Invalid response from server"
        case .notSignedIn:
            return "Sign in required to transfer"
        case .exportFailed(let statusCode):
            return "Export failed (HTTP \(statusCode))"
        case .exportTimedOut:
            return "Export timed out after 5 minutes"
        case .importFailed(let message):
            return "Import failed: \(message)"
        case .managedEntryNotFound:
            return "Could not find managed assistant entry after creation"
        case .localAssistantNotFound:
            return "Could not find or create a local assistant"
        }
    }
}
