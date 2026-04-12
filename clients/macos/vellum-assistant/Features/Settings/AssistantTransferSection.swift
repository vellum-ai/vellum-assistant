import Foundation
import os
import SwiftUI
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AssistantTransfer")

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
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)

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
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
            }

            if let error = errorMessage {
                Text(error)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard()
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
            .font(VFont.labelDefault)
            .foregroundStyle(VColor.contentTertiary)

        VButton(
            label: isTransferring ? "Transferring..." : "Transfer to Cloud",
            style: .primary,
            isDisabled: isTransferring || SessionTokenManager.getToken() == nil
        ) {
            showingConfirmation = true
        }

        if SessionTokenManager.getToken() == nil {
            Text("Sign in to transfer your assistant to the cloud.")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
    }

    // MARK: - Managed → Local Content

    @ViewBuilder
    private var managedToLocalContent: some View {
        Text("Move your assistant and all its data to this Mac.")
            .font(VFont.labelDefault)
            .foregroundStyle(VColor.contentTertiary)

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
            let lockfileSuccess = LockfileAssistant.ensureManagedEntry(
                assistantId: platformAssistant.id,
                runtimeUrl: VellumEnvironment.resolvedPlatformURL,
                hatchedAt: platformAssistant.created_at ?? Date().iso8601String
            )
            guard lockfileSuccess else {
                throw TransferError.importFailed(message: "Failed to save managed assistant configuration to lockfile.")
            }

            // Step 3 — Import bundle to managed assistant
            currentStep = "Uploading data to cloud..."
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
                let client = AssistantManagementClient.create(for: assistant)
                try await client.retire(name: localName)
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
                let (statusResult, statusResponse): (ExportStatusResponse?, _) = try await GatewayHTTPClient.get(
                    path: "migrations/export/\(jobId)/status"
                ) { $0.keyDecodingStrategy = .convertFromSnakeCase }
                guard statusResponse.isSuccess, let statusResult else {
                    throw TransferError.exportFailed(statusCode: statusResponse.statusCode)
                }

                if statusResult.status == "complete" {
                    guard let url = statusResult.downloadUrl else {
                        throw TransferError.exportFailed(statusCode: 0)
                    }
                    downloadUrl = url
                    break
                } else if statusResult.status == "failed" {
                    throw TransferError.importFailed(message: statusResult.error ?? "Export job failed")
                } else if statusResult.status == "pending" || statusResult.status == "processing" {
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
                try await AppDelegate.shared?.vellumCli.hatch()
                localAssistant = LockfileAssistant.loadAll().first(where: { !$0.isRemote && !$0.isManaged })
            } else {
                // Existing local assistant may be sleeping — wake it before health check
                try await AppDelegate.shared?.vellumCli.wake(name: localAssistant!.assistantId)
            }
            guard let resolvedLocal = localAssistant else {
                throw TransferError.localAssistantNotFound
            }

            // Wait for gateway readiness (up to 30s)
            for i in 0..<30 {
                if await HealthCheckClient.isReachable(for: resolvedLocal, timeout: 1) {
                    break
                }
                if i == 29 {
                    throw TransferError.localAssistantNotFound
                }
                try await Task.sleep(nanoseconds: 1_000_000_000)
            }

            // Step 5 — Bootstrap actor token against the local gateway
            // (without calling performSwitchAssistant, which destroys the window)
            currentStep = "Authenticating with local assistant..."
            let actorToken = try await bootstrapActorToken(localAssistantId: resolvedLocal.assistantId)
            ActorTokenManager.setToken(actorToken)

            // Step 6 — Import to local (route to local assistant's gateway)
            currentStep = "Importing data..."
            let importResponse = try await GatewayHTTPClient.withAssistant(resolvedLocal.assistantId) {
                try await GatewayHTTPClient.post(
                    path: "assistants/{assistantId}/migrations/import",
                    body: bundleData,
                    contentType: "application/octet-stream",
                    timeout: 120
                )
            }
            guard importResponse.isSuccess else {
                throw TransferError.importFailed(message: "HTTP \(importResponse.statusCode)")
            }
            if let importJson = try? JSONSerialization.jsonObject(with: importResponse.data) as? [String: Any],
               let success = importJson["success"] as? Bool, !success {
                let errorMsg = (importJson["error"] as? String) ?? "Import reported failure"
                throw TransferError.importFailed(message: errorMsg)
            }

            // Step 7 — Switch to local assistant now that import succeeded
            AppDelegate.shared?.performSwitchAssistant(to: resolvedLocal)
            transferTask = nil
            onClose()

            // Step 8 — Retire managed assistant (fire-and-forget, route to managed gateway)
            currentStep = "Cleaning up..."
            do {
                let retireResponse = try await GatewayHTTPClient.withAssistant(managedAssistantId) {
                    try await GatewayHTTPClient.delete(
                        path: "assistants/{assistantId}/retire",
                        timeout: 30
                    )
                }
                if retireResponse.isSuccess {
                    log.info("[transfer] Retired managed assistant \(managedAssistantId, privacy: .public)")
                } else {
                    log.error("[transfer] Failed to retire managed assistant \(managedAssistantId, privacy: .public): HTTP \(retireResponse.statusCode, privacy: .public)")
                }
            } catch {
                log.error("[transfer] Failed to retire managed assistant \(managedAssistantId, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
        } catch {
            errorMessage = "Transfer failed: \(error.localizedDescription)"
        }
    }

    // MARK: - Local → Managed Transfer Helpers

    /// Exports the local assistant's data as a `.vbundle` binary archive.
    private func exportAssistantBundle() async throws -> Data {
        let response = try await GatewayHTTPClient.post(
            path: "assistants/{assistantId}/migrations/export",
            timeout: 60
        )
        guard response.isSuccess else {
            throw TransferError.exportFailed(statusCode: response.statusCode)
        }
        return response.data
    }

    /// Bootstraps an actor token against a local assistant's gateway `/v1/guardian/init`
    /// endpoint without going through `performSwitchAssistant` (which destroys the window).
    /// Uses the process-local assistant override to route requests to the local
    /// assistant's gateway. Retries with exponential backoff up to ~30s.
    private func bootstrapActorToken(localAssistantId: String) async throws -> String {
        let deviceId = PairingQRCodeSheet.computeHostId()
        let body: [String: String] = ["platform": "macos", "deviceId": deviceId]

        return try await GatewayHTTPClient.withAssistant(localAssistantId) {
            var delay: UInt64 = 2_000_000_000
            for attempt in 0..<6 {
                try Task.checkCancellation()

                if let response = try? await GatewayHTTPClient.post(
                    path: "assistants/{assistantId}/guardian/init",
                    json: body,
                    timeout: 15
                ), response.isSuccess,
                   let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
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
    }

    /// Imports a `.vbundle` archive into the managed assistant via the signed URL upload flow.
    ///
    /// Uses 3 steps: request signed URL → upload to GCS → trigger import from GCS.
    /// All endpoints are org-scoped, so no `connectedAssistantId` swap is needed.
    private func importBundleToManaged(bundleData: Data) async throws {
        // Step 1: Request a signed upload URL from the platform
        let uploadInfo = try await PlatformMigrationClient.requestUploadUrl()

        // Step 2: Upload bundle directly to GCS via signed URL
        try await PlatformMigrationClient.uploadToSignedUrl(uploadInfo.uploadUrl, bundleData: bundleData)

        // Step 3: Trigger import from GCS
        let (statusCode, data) = try await PlatformMigrationClient.importFromGcs(bundleKey: uploadInfo.bundleKey)

        guard (200..<300).contains(statusCode) else {
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let errorMsg = json["error"] as? String {
                throw TransferError.importFailed(message: errorMsg)
            }
            throw TransferError.importFailed(message: "HTTP \(statusCode)")
        }

        // Handle async import: 202 means the job was accepted and we need to poll
        if statusCode == 202 {
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let jobId = json["job_id"] as? String else {
                throw TransferError.importFailed(message: "Import accepted but no job ID returned")
            }

            let pollInterval: UInt64 = 5_000_000_000 // 5 seconds
            let timeout: TimeInterval = 600 // 10 minutes
            let start = Date()

            while Date().timeIntervalSince(start) < timeout {
                try await Task.sleep(nanoseconds: pollInterval)

                let status: PlatformMigrationClient.ImportJobStatus
                do {
                    status = try await PlatformMigrationClient.pollImportStatus(jobId: jobId)
                } catch is CancellationError {
                    throw CancellationError()
                } catch let error as PlatformMigrationClient.PlatformMigrationError {
                    // Only retry on transient 5xx server errors
                    // All other PlatformMigrationError cases (notAuthenticated, 4xx, etc.) are permanent
                    if case .requestFailed(let statusCode, _) = error, (500..<600).contains(statusCode) {
                        continue
                    }
                    // Permanent error — fail fast
                    throw error
                } catch {
                    // Transient network errors — retry on next cycle
                    continue
                }

                if status.status == "complete" {
                    return
                }
                if status.status == "failed" {
                    throw TransferError.importFailed(message: status.error ?? "Import job failed")
                }
            }
            throw TransferError.importFailed(message: "Import timed out after 10 minutes")
        }

        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let success = json["success"] as? Bool, !success {
            let errorMsg = (json["error"] as? String) ?? "Import reported failure"
            throw TransferError.importFailed(message: errorMsg)
        }
    }
}

// MARK: - Transfer Errors

private struct ExportStatusResponse: Decodable {
    let status: String
    let downloadUrl: String?
    let error: String?
}

private enum TransferError: LocalizedError {
    case invalidURL
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
