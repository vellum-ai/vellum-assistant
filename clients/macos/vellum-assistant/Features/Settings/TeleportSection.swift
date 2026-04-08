import Foundation
import os
import SwiftUI
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "Teleport")

// MARK: - Teleport Destination

private enum TeleportDestination {
    case docker
    case platform

    var displayLabel: String {
        switch self {
        case .docker:
            return "Move to Docker"
        case .platform:
            return "Move to Cloud (Platform)"
        }
    }

    var description: String {
        switch self {
        case .docker:
            return "Run your assistant in a Docker container on this Mac."
        case .platform:
            return "Run your assistant in the cloud, managed by the Vellum platform."
        }
    }
}

// MARK: - Teleport Phase

private enum TeleportPhase {
    case idle
    case transferring(step: String)
    case verifying
    case failed(error: String)
}

// MARK: - Teleport Errors

private enum TeleportError: LocalizedError {
    case invalidURL
    case notSignedIn
    case exportFailed(statusCode: Int)
    case exportTimedOut
    case importFailed(message: String)
    case managedEntryNotFound
    case localAssistantNotFound
    case dockerAssistantNotFound
    case noOrganizations
    case multipleOrganizations

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid URL"
        case .notSignedIn:
            return "Sign in required to teleport"
        case .exportFailed(let statusCode):
            return "Export failed (HTTP \(statusCode))"
        case .exportTimedOut:
            return "Export timed out"
        case .importFailed(let message):
            return "Import failed: \(message)"
        case .managedEntryNotFound:
            return "Could not find managed assistant entry after creation"
        case .localAssistantNotFound:
            return "Could not find or create a local assistant"
        case .dockerAssistantNotFound:
            return "Could not find or create a Docker assistant"
        case .noOrganizations:
            return "No organizations found for this account"
        case .multipleOrganizations:
            return "Multiple organizations found — please select one in account settings first"
        }
    }
}

// MARK: - TeleportSection View

/// Teleport UI for moving an assistant between hosting environments without retiring the source.
///
/// Unlike `AssistantTransferSection`, teleport preserves the source assistant until the user
/// explicitly confirms the new one works. After transfer, a verification banner lets the user
/// either confirm (and retire the old assistant) or restore back to the original.
@MainActor
struct TeleportSection: View {
    let assistant: LockfileAssistant
    let onClose: () -> Void

    @State private var phase: TeleportPhase = .idle
    @State private var showingConfirmation = false
    @State private var pendingDestination: TeleportDestination?
    @State private var transferTask: Task<Void, Never>?
    @State private var originalAssistant: LockfileAssistant?
    @State private var targetAssistant: LockfileAssistant?
    @State private var transferProgress: Double? = nil

    var body: some View {
        Group {
            if assistant.isManaged || (assistant.isRemote && !assistant.isDocker) {
                EmptyView()
            } else {
                teleportContent
            }
        }
        .alert(confirmationTitle, isPresented: $showingConfirmation) {
            Button("Cancel", role: .cancel) {
                pendingDestination = nil
            }
            Button("Teleport", role: .destructive) {
                guard let destination = pendingDestination else { return }
                originalAssistant = assistant
                transferTask = Task { await executeTeleport(to: destination) }
            }
        } message: {
            Text(confirmationMessage)
        }
        .onDisappear {
            transferTask?.cancel()
        }
    }

    private var confirmationTitle: String {
        pendingDestination?.displayLabel ?? "Teleport"
    }

    private var confirmationMessage: String {
        "Your data will be copied to the new environment. The current assistant will remain available until you confirm the new one works."
    }

    // MARK: - Content

    @ViewBuilder
    private var teleportContent: some View {
        SettingsCard(title: "Teleport", subtitle: "Move your assistant to a different hosting environment") {
            if case .verifying = phase {
                verifyingBanner
            } else if case .transferring(let step) = phase {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    HStack(spacing: VSpacing.sm) {
                        if transferProgress == nil || (transferProgress ?? 0) < 0 {
                            ProgressView()
                                .controlSize(.small)
                        }
                        Text(step)
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                    }
                    if let transferProgress, transferProgress >= 0 {
                        ProgressView(value: transferProgress)
                            .progressViewStyle(.linear)
                            .tint(VColor.primaryBase)
                            .frame(maxWidth: 240)
                    }
                }
            } else if case .failed(let error) = phase {
                failedBanner(error: error)
            } else {
                destinationPicker
            }
        }
    }

    // MARK: - Destination Picker

    @ViewBuilder
    private var destinationPicker: some View {
        if assistant.cloud.lowercased() == "local" || assistant.isDocker {
            destinationButton(for: .platform)
        }
    }

    @ViewBuilder
    private func destinationButton(for destination: TeleportDestination) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text(destination.description)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)

            VButton(
                label: destination.displayLabel,
                style: .outlined,
                isDisabled: isDestinationDisabled(destination)
            ) {
                pendingDestination = destination
                showingConfirmation = true
            }

            if destination == .platform && SessionTokenManager.getToken() == nil {
                Text("Sign in to move to cloud.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
    }

    private func isDestinationDisabled(_ destination: TeleportDestination) -> Bool {
        if case .idle = phase {} else { return true }
        if destination == .platform && SessionTokenManager.getToken() == nil {
            return true
        }
        return false
    }

    // MARK: - Verifying Banner

    @ViewBuilder
    private var verifyingBanner: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            HStack(spacing: VSpacing.sm) {
                VIconView(.circleCheck, size: 16)
                    .foregroundStyle(VColor.systemPositiveStrong)
                Text("Transfer complete — verify your new assistant is working.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentDefault)
            }

            HStack(spacing: VSpacing.sm) {
                VButton(
                    label: "Confirm & Switch",
                    style: .primary
                ) {
                    confirmAndSwitch()
                }

                VButton(
                    label: "Cancel",
                    style: .outlined
                ) {
                    cancelTeleport()
                }
            }
        }
    }

    // MARK: - Failed Banner

    @ViewBuilder
    private func failedBanner(error: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text(error)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.systemNegativeStrong)

            VButton(
                label: "Try Again",
                style: .outlined
            ) {
                transferProgress = nil
                phase = .idle
            }
        }
    }

    // MARK: - Confirm & Cancel

    private func confirmAndSwitch() {
        guard let target = targetAssistant else { return }
        let original = originalAssistant

        // Switch to the new assistant (this destroys the window)
        AppDelegate.shared?.performSwitchAssistant(to: target)

        // Fire-and-forget retirement of the old assistant
        if let original {
            let oldId = original.assistantId
            Task {
                if original.isManaged {
                    do {
                        let response = try await GatewayHTTPClient.withAssistant(oldId) {
                            try await GatewayHTTPClient.delete(
                                path: "assistants/{assistantId}/retire",
                                timeout: 30
                            )
                        }
                        if response.isSuccess {
                            log.info("[teleport] Retired managed assistant \(oldId, privacy: .public)")
                        } else {
                            log.error("[teleport] Failed to retire managed assistant \(oldId, privacy: .public): HTTP \(response.statusCode, privacy: .public)")
                        }
                    } catch {
                        log.error("[teleport] Failed to retire managed assistant \(oldId, privacy: .public): \(error.localizedDescription, privacy: .public)")
                    }
                } else {
                    do {
                        try await AppDelegate.shared?.vellumCli.retire(name: oldId)
                        log.info("[teleport] Retired assistant \(oldId, privacy: .public)")
                    } catch {
                        log.error("[teleport] Failed to retire assistant \(oldId, privacy: .public): \(error.localizedDescription, privacy: .public)")
                    }
                }
            }
        }

        onClose()
    }

    private func cancelTeleport() {
        // Sleep docker assistant to free resources if it was the target
        if let target = targetAssistant, target.isDocker {
            let dockerId = target.assistantId
            Task {
                do {
                    try await AppDelegate.shared?.vellumCli.sleep(name: dockerId)
                    log.info("[teleport] Slept Docker assistant \(dockerId, privacy: .public) after cancel")
                } catch {
                    log.error("[teleport] Failed to sleep Docker assistant \(dockerId, privacy: .public): \(error.localizedDescription, privacy: .public)")
                }
            }
        }
        transferProgress = nil
        phase = .idle
        targetAssistant = nil
    }

    // MARK: - Transfer Execution

    private func executeTeleport(to destination: TeleportDestination) async {
        phase = .transferring(step: "Preparing...")

        do {
            switch (assistant.isDocker, destination) {
            case (false, .platform):
                try await teleportLocalToPlatform()
            case (false, .docker):
                try await teleportLocalToDocker()
            case (true, .platform):
                try await teleportDockerToPlatform()
            default:
                throw TeleportError.invalidURL
            }
        } catch {
            transferProgress = nil
            phase = .failed(error: "Teleport failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Local -> Platform

    private func teleportLocalToPlatform() async throws {
        // Step 1 — Export local assistant data
        phase = .transferring(step: "Exporting assistant data...")
        let bundleData = try await exportAssistantBundle(onProgress: { self.transferProgress = $0 })

        // Step 2 — Resolve and validate org ID before upload (upload reads org from UserDefaults)
        transferProgress = nil
        phase = .transferring(step: "Resolving organization...")
        let organizationId = try await resolveOrganizationId()

        // Step 3 — Upload to GCS via signed URL (with inline fallback)
        phase = .transferring(step: "Uploading data to cloud...")
        let bundleKey: String?
        do {
            let uploadInfo = try await PlatformMigrationClient.requestUploadUrl()
            try await PlatformMigrationClient.uploadToSignedUrl(uploadInfo.uploadUrl, bundleData: bundleData, onProgress: { self.transferProgress = $0 })
            bundleKey = uploadInfo.bundleKey
        } catch let error as PlatformMigrationClient.PlatformMigrationError {
            if case .signedUrlsNotAvailable = error {
                bundleKey = nil
            } else {
                throw error
            }
        }

        // Step 4 — Ensure managed assistant exists on platform via direct hatch
        transferProgress = nil
        phase = .transferring(step: "Setting up cloud assistant...")
        let hatchResult = try await AuthService.shared.hatchAssistant(organizationId: organizationId)
        let platformAssistant: PlatformAssistant
        switch hatchResult {
        case .reusedExisting(let assistant):
            platformAssistant = assistant
        case .createdNew(let assistant):
            platformAssistant = assistant
        }
        let lockfileSuccess = LockfileAssistant.ensureManagedEntry(
            assistantId: platformAssistant.id,
            runtimeUrl: AuthService.shared.baseURL,
            hatchedAt: platformAssistant.created_at ?? Date().iso8601String
        )
        guard lockfileSuccess else {
            throw TeleportError.importFailed(message: "Failed to save managed assistant configuration to lockfile.")
        }

        // Step 5 — Import bundle to managed assistant
        phase = .transferring(step: "Importing data to cloud...")
        try await importBundleToManaged(bundleData: bundleData, bundleKey: bundleKey)

        // Step 6 — Resolve managed assistant for later switch
        guard let managedAssistant = LockfileAssistant.loadAll().first(where: { $0.assistantId == platformAssistant.id && $0.isManaged }) else {
            throw TeleportError.managedEntryNotFound
        }
        targetAssistant = managedAssistant
        transferTask = nil

        // Step 7 — Verification phase (do NOT retire or switch yet)
        phase = .verifying
    }

    // MARK: - Local -> Docker

    private func teleportLocalToDocker() async throws {
        // Step 1 — Export local assistant data
        phase = .transferring(step: "Exporting assistant data...")
        let bundleData = try await exportAssistantBundle(onProgress: { self.transferProgress = $0 })

        // Step 2 — Ensure a docker assistant exists
        transferProgress = nil
        phase = .transferring(step: "Preparing Docker assistant...")
        var dockerAssistant = LockfileAssistant.loadAll().first(where: { $0.isDocker })
        if dockerAssistant == nil {
            // Hatch a new docker assistant
            let config = VellumCli.RemoteHatchConfig(remote: "docker")
            try await AppDelegate.shared?.vellumCli.runRemoteHatch(config: config) { _ in }
            dockerAssistant = LockfileAssistant.loadAll().first(where: { $0.isDocker })
        } else {
            // Wake existing docker assistant
            try await AppDelegate.shared?.vellumCli.wake(name: dockerAssistant!.assistantId)
        }
        guard let resolvedDocker = dockerAssistant else {
            throw TeleportError.dockerAssistantNotFound
        }

        // Step 3 — Wait for docker gateway readiness (up to 30s)
        phase = .transferring(step: "Waiting for Docker assistant...")
        for i in 0..<30 {
            if await HealthCheckClient.isReachable(for: resolvedDocker, timeout: 1) {
                break
            }
            if i == 29 {
                throw TeleportError.dockerAssistantNotFound
            }
            try await Task.sleep(nanoseconds: 1_000_000_000)
        }

        // Step 4 — Bootstrap actor token against docker gateway
        phase = .transferring(step: "Authenticating with Docker assistant...")
        let originalActorToken = ActorTokenManager.getToken()
        let actorToken = try await bootstrapActorToken(targetAssistantId: resolvedDocker.assistantId)
        ActorTokenManager.setToken(actorToken)
        defer {
            // Restore original actor token so the local assistant works during verification
            if let originalActorToken {
                ActorTokenManager.setToken(originalActorToken)
            } else {
                ActorTokenManager.deleteToken()
            }
        }

        // Step 5 — Import bundle to docker assistant
        phase = .transferring(step: "Importing data to Docker...")
        let importResponse = try await GatewayHTTPClient.withAssistant(resolvedDocker.assistantId) {
            try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/migrations/import",
                body: bundleData,
                contentType: "application/octet-stream",
                timeout: 120
            )
        }
        guard importResponse.isSuccess else {
            throw TeleportError.importFailed(message: "HTTP \(importResponse.statusCode)")
        }
        if let importJson = try? JSONSerialization.jsonObject(with: importResponse.data) as? [String: Any],
           let success = importJson["success"] as? Bool, !success {
            let errorMsg = (importJson["error"] as? String) ?? "Import reported failure"
            throw TeleportError.importFailed(message: errorMsg)
        }

        // Step 6 — Store target for user confirmation (do NOT switch yet)
        targetAssistant = resolvedDocker
        transferTask = nil

        // Step 7 — Verification phase (do NOT retire or switch yet)
        phase = .verifying
    }

    // MARK: - Docker -> Platform

    private func teleportDockerToPlatform() async throws {
        // Step 1 — Export docker assistant data
        phase = .transferring(step: "Exporting assistant data...")
        let bundleData = try await exportAssistantBundle(onProgress: { self.transferProgress = $0 })

        // Step 2 — Resolve and validate org ID before upload (upload reads org from UserDefaults)
        transferProgress = nil
        phase = .transferring(step: "Resolving organization...")
        let organizationId = try await resolveOrganizationId()

        // Step 3 — Upload to GCS via signed URL (with inline fallback)
        phase = .transferring(step: "Uploading data to cloud...")
        let bundleKey: String?
        do {
            let uploadInfo = try await PlatformMigrationClient.requestUploadUrl()
            try await PlatformMigrationClient.uploadToSignedUrl(uploadInfo.uploadUrl, bundleData: bundleData, onProgress: { self.transferProgress = $0 })
            bundleKey = uploadInfo.bundleKey
        } catch let error as PlatformMigrationClient.PlatformMigrationError {
            if case .signedUrlsNotAvailable = error {
                bundleKey = nil
            } else {
                throw error
            }
        }

        // Step 4 — Ensure managed assistant exists on platform via direct hatch
        transferProgress = nil
        phase = .transferring(step: "Setting up cloud assistant...")
        let hatchResult = try await AuthService.shared.hatchAssistant(organizationId: organizationId)
        let platformAssistant: PlatformAssistant
        switch hatchResult {
        case .reusedExisting(let assistant):
            platformAssistant = assistant
        case .createdNew(let assistant):
            platformAssistant = assistant
        }
        let lockfileSuccess = LockfileAssistant.ensureManagedEntry(
            assistantId: platformAssistant.id,
            runtimeUrl: AuthService.shared.baseURL,
            hatchedAt: platformAssistant.created_at ?? Date().iso8601String
        )
        guard lockfileSuccess else {
            throw TeleportError.importFailed(message: "Failed to save managed assistant configuration to lockfile.")
        }

        // Step 5 — Import bundle to managed assistant
        phase = .transferring(step: "Importing data to cloud...")
        try await importBundleToManaged(bundleData: bundleData, bundleKey: bundleKey)

        // Step 6 — Resolve managed assistant for later switch
        guard let managedAssistant = LockfileAssistant.loadAll().first(where: { $0.assistantId == platformAssistant.id && $0.isManaged }) else {
            throw TeleportError.managedEntryNotFound
        }
        targetAssistant = managedAssistant
        transferTask = nil

        // Step 7 — Verification phase (do NOT retire or switch yet)
        phase = .verifying
    }

    // MARK: - Helpers

    /// Resolves and validates the organization ID, mirroring the logic in
    /// `ManagedAssistantBootstrapService.resolveOrganizationId()`.
    ///
    /// Always fetches orgs from the API and validates any persisted value.
    /// Persists the resolved org ID to UserDefaults so downstream callers
    /// (e.g. `PlatformMigrationClient.requestUploadUrl()`) can read it.
    private func resolveOrganizationId() async throws -> String {
        let orgs = try await AuthService.shared.getOrganizations()
        let persistedOrgId = UserDefaults.standard.string(forKey: "connectedOrganizationId")

        // If a persisted org ID exists and is valid, use it
        if let persistedOrgId, !persistedOrgId.isEmpty, orgs.contains(where: { $0.id == persistedOrgId }) {
            log.info("[teleport] Validated persisted organization: \(persistedOrgId, privacy: .public)")
            return persistedOrgId
        }

        if persistedOrgId != nil {
            log.warning("[teleport] Persisted organization ID not found in user's orgs — re-resolving")
        }

        // Re-resolve from the org list
        switch orgs.count {
        case 0:
            throw TeleportError.noOrganizations
        case 1:
            let orgId = orgs[0].id
            UserDefaults.standard.set(orgId, forKey: "connectedOrganizationId")
            log.info("[teleport] Resolved organization: \(orgId, privacy: .public)")
            return orgId
        default:
            throw TeleportError.multipleOrganizations
        }
    }

    /// Exports the current assistant's data as a `.vbundle` binary archive.
    private func exportAssistantBundle(onProgress: (@MainActor (Double) -> Void)? = nil) async throws -> Data {
        let response: GatewayHTTPClient.Response
        if let onProgress {
            response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/migrations/export",
                timeout: 60,
                onProgress: onProgress
            )
        } else {
            response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/migrations/export",
                timeout: 60
            )
        }
        guard response.isSuccess else {
            throw TeleportError.exportFailed(statusCode: response.statusCode)
        }
        return response.data
    }

    /// Imports a `.vbundle` archive into the managed assistant.
    ///
    /// If `bundleKey` is non-nil, triggers import from GCS (the bundle was already uploaded
    /// via a signed URL). Otherwise, falls back to inline import by sending the raw bundle
    /// data directly to the platform.
    ///
    /// All endpoints are org-scoped, so no `connectedAssistantId` swap is needed.
    private func importBundleToManaged(bundleData: Data, bundleKey: String?) async throws {
        let statusCode: Int
        let data: Data

        if let bundleKey {
            (statusCode, data) = try await PlatformMigrationClient.importFromGcs(bundleKey: bundleKey)
        } else {
            (statusCode, data) = try await PlatformMigrationClient.importInline(bundleData: bundleData)
        }

        guard (200..<300).contains(statusCode) else {
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let errorMsg = json["error"] as? String {
                throw TeleportError.importFailed(message: errorMsg)
            }
            throw TeleportError.importFailed(message: "HTTP \(statusCode)")
        }

        // Handle async import: 202 means the job was accepted and we need to poll
        if statusCode == 202 {
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let jobId = json["job_id"] as? String else {
                throw TeleportError.importFailed(message: "Import accepted but no job ID returned")
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
                    // Only fail fast on permanent 4xx errors
                    // Retry transient 5xx errors
                    if case .requestFailed(let statusCode, _) = error, (400..<500).contains(statusCode) {
                        throw error
                    }
                    // Transient server error — retry on next cycle
                    continue
                } catch {
                    // Transient network errors — retry on next cycle
                    continue
                }

                if status.status == "complete" {
                    return
                }
                if status.status == "failed" {
                    throw TeleportError.importFailed(message: status.error ?? "Import job failed")
                }
            }
            throw TeleportError.importFailed(message: "Import timed out after 10 minutes")
        }

        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let success = json["success"] as? Bool, !success {
            let errorMsg = (json["error"] as? String) ?? "Import reported failure"
            throw TeleportError.importFailed(message: errorMsg)
        }
    }

    /// Bootstraps an actor token against a target assistant's gateway `/v1/guardian/init`
    /// endpoint. Uses the process-local assistant override to route requests to the
    /// target assistant's gateway. Retries with exponential backoff up to ~30s.
    private func bootstrapActorToken(targetAssistantId: String) async throws -> String {
        let deviceId = PairingQRCodeSheet.computeHostId()
        let body: [String: String] = ["platform": "macos", "deviceId": deviceId]

        return try await GatewayHTTPClient.withAssistant(targetAssistantId) {
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

            throw TeleportError.notSignedIn
        }
    }
}
