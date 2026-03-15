import Foundation
import SwiftUI
import VellumAssistantShared

/// Transfer UI for moving an assistant between local and cloud (managed) hosting.
///
/// For local assistants, offers "Transfer to Cloud" which exports a `.vbundle`,
/// creates/discovers a managed assistant on the platform, imports the bundle,
/// switches the active connection, and retires the local assistant.
///
/// For managed assistants, shows a placeholder "Transfer to Local" button
/// (implementation in a follow-up PR).
@MainActor
struct AssistantTransferSection: View {
    let assistant: LockfileAssistant
    let store: SettingsStore
    let authManager: AuthManager
    let onClose: () -> Void

    @State private var isTransferring = false
    @State private var currentStep: String?
    @State private var showingConfirmation = false
    @State private var errorMessage: String?
    @State private var successMessage: String?

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

            if let success = successMessage {
                Text(success)
                    .font(VFont.caption)
                    .foregroundColor(VColor.systemPositiveStrong)
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceOverlay)
        .alert("Transfer to Cloud", isPresented: $showingConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Transfer", role: .destructive) {
                Task { await transferLocalToManaged() }
            }
        } message: {
            Text("This will move all conversations, memory, and settings to a cloud-hosted assistant, then retire the local one. This cannot be undone.")
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
            label: "Transfer to Local",
            style: .primary,
            isDisabled: true
        ) {
            // Implementation in PR 3
        }

        Text("Coming soon")
            .font(VFont.caption)
            .foregroundColor(VColor.contentTertiary)
    }

    // MARK: - Transfer Logic

    private func transferLocalToManaged() async {
        isTransferring = true
        errorMessage = nil
        successMessage = nil
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
            LockfileAssistant.upsertManagedEntry(
                assistantId: platformAssistant.id,
                runtimeUrl: AuthService.shared.baseURL,
                hatchedAt: platformAssistant.created_at ?? ISO8601DateFormatter().string(from: Date())
            )

            // Step 3 — Import bundle to managed assistant
            currentStep = "Importing data to cloud..."
            try await importBundleToManaged(bundleData: bundleData)

            // Step 4 — Switch to managed assistant
            currentStep = "Switching to cloud assistant..."
            guard let managedAssistant = LockfileAssistant.loadAll().first(where: { $0.isManaged }) else {
                throw TransferError.managedEntryNotFound
            }
            AppDelegate.shared?.performSwitchAssistant(to: managedAssistant)
            onClose()

            // Step 5 — Retire local assistant (fire-and-forget)
            currentStep = "Cleaning up..."
            let localName = assistant.assistantId
            try? await AppDelegate.shared?.assistantCli.retire(name: localName)

            successMessage = "Transfer complete. You are now using the cloud assistant."
        } catch {
            errorMessage = "Transfer failed: \(error.localizedDescription)"
        }
    }

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
    case importFailed(message: String)
    case managedEntryNotFound

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
        case .importFailed(let message):
            return "Import failed: \(message)"
        case .managedEntryNotFound:
            return "Could not find managed assistant entry after creation"
        }
    }
}
