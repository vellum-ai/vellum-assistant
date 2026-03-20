import Foundation
import SwiftUI
import VellumAssistantShared

/// Topology classification for upgrade UI behavior.
enum AssistantTopology {
    case local       // Sparkle-managed binary
    case docker      // CLI-managed containers
    case managed     // Platform-managed (Vellum cloud)
    case remote      // GCP, custom, SSH — no automatic upgrade mechanism
}

/// Upgrade section for managed/remote assistants.
///
/// Shows the current version, checks for available releases, and provides
/// an "Upgrade Now" button to trigger a platform-side upgrade.
/// Only displayed when the assistant is managed (`isManaged == true`).
@MainActor
struct AssistantUpgradeSection: View {
    let currentVersion: String?
    let topology: AssistantTopology

    @State private var availableReleases: [AssistantRelease] = []
    @State private var selectedVersion: String?
    @State private var isLoadingReleases = false
    @State private var isUpgrading = false
    @State private var errorMessage: String?
    @State private var successMessage: String?
    @State private var showingUpgradeConfirmation = false

    private var latestRelease: AssistantRelease? {
        availableReleases.first
    }

    private var effectiveSelectedVersion: String? {
        selectedVersion ?? latestRelease?.version
    }

    private var upgradeAvailable: Bool {
        guard let target = effectiveSelectedVersion, let current = currentVersion, !current.isEmpty else { return false }
        return target != current
    }

    /// Whether the selected target version is older than the current version.
    private var isRollback: Bool {
        guard let target = effectiveSelectedVersion,
              let current = currentVersion, !current.isEmpty else {
            return false
        }
        return target.compare(current, options: .numeric) == .orderedAscending
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Upgrade")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.contentDefault)

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                if let current = currentVersion, !current.isEmpty {
                    HStack(spacing: VSpacing.sm) {
                        Text("Current version:")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                        Text(current)
                            .font(VFont.mono)
                            .foregroundColor(VColor.contentDefault)
                    }
                }

                if !availableReleases.isEmpty {
                    HStack(spacing: VSpacing.sm) {
                        Text("Upgrade to:")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                        Picker("", selection: Binding<String>(
                            get: { selectedVersion ?? latestRelease?.version ?? "" },
                            set: { newValue in
                                selectedVersion = (newValue == latestRelease?.version) ? nil : newValue
                            }
                        )) {
                            ForEach(availableReleases) { release in
                                Text(release.version == latestRelease?.version
                                     ? "\(release.version) (latest)"
                                     : release.version)
                                    .tag(release.version)
                            }
                        }
                        .pickerStyle(.menu)
                    }
                }

                if !upgradeAvailable && !isLoadingReleases && !availableReleases.isEmpty {
                    Text(selectedVersion == nil
                         ? "You are on the latest version."
                         : "You are already on this version.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.systemPositiveStrong)
                }
            }

            if topology == .remote {
                HStack(spacing: VSpacing.xs) {
                    VIconView(.triangleAlert, size: 12)
                        .foregroundColor(VColor.systemMidStrong)
                    Text("Automatic upgrades are not available for this deployment. Upgrade your infrastructure manually.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
            }

            HStack(spacing: VSpacing.md) {
                if topology == .local {
                    VButton(label: "Check for App Updates", style: .outlined) {
                        AppDelegate.shared?.updateManager.checkForUpdates()
                    }
                } else if topology != .remote {
                    // Docker and managed get the upgrade button
                    VButton(
                        label: isUpgrading
                            ? (isRollback ? "Rolling back..." : "Upgrading...")
                            : (isRollback ? "Roll Back" : "Upgrade Now"),
                        style: isRollback ? .outlined : .primary
                    ) {
                        showingUpgradeConfirmation = true
                    }
                    .disabled(!upgradeAvailable || isUpgrading)
                }

                VButton(
                    label: isLoadingReleases ? "Checking..." : "Check for Updates",
                    style: .outlined
                ) {
                    Task { await loadReleases() }
                }
                .disabled(isLoadingReleases || isUpgrading)
            }

            if isLoadingReleases || isUpgrading {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text(isUpgrading ? "Upgrading assistant..." : "Checking for updates...")
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
        .frame(maxWidth: .infinity, alignment: .leading)
        .task { await loadReleases() }
        .alert(isRollback ? "Roll Back Assistant" : "Upgrade Assistant", isPresented: $showingUpgradeConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button(isRollback ? "Roll Back" : "Upgrade") {
                Task { await performUpgrade() }
            }
        } message: {
            if isRollback {
                Text("Roll back to version \(effectiveSelectedVersion ?? "unknown")? The assistant will be briefly unavailable.")
            } else {
                Text("Upgrade to version \(effectiveSelectedVersion ?? "latest")? The assistant will be briefly unavailable during the upgrade.")
            }
        }
    }

    // MARK: - Actions

    private func loadReleases() async {
        clearMessages()
        await loadReleasesQuietly()
    }

    /// Fetches releases without clearing existing messages.
    /// Hits the platform `GET /v1/releases/` endpoint directly (unauthenticated).
    /// When the user has a session token, it's attached so the platform can
    /// auto-filter to releases newer than the assistant's current version.
    private func loadReleasesQuietly() async {
        isLoadingReleases = true
        defer { isLoadingReleases = false }

        let platformBase = AuthService.shared.baseURL
        guard let url = URL(string: "\(platformBase)/v1/releases/?stable=true") else {
            errorMessage = "Failed to check for updates"
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // Attach auth headers when available so the platform can auto-filter
        // by the assistant's current release. The endpoint works without auth
        // too — it just returns all stable releases in that case.
        if let token = await SessionTokenManager.getTokenAsync() {
            request.setValue(token, forHTTPHeaderField: "X-Session-Token")
        }
        if let orgId = UserDefaults.standard.string(forKey: "connectedOrganizationId") {
            request.setValue(orgId, forHTTPHeaderField: "Vellum-Organization-Id")
        }

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                errorMessage = "Failed to check for updates"
                return
            }
            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .convertFromSnakeCase
            availableReleases = try decoder.decode([AssistantRelease].self, from: data)
        } catch {
            errorMessage = "Failed to check for updates: \(error.localizedDescription)"
        }
    }

    private func performUpgrade() async {
        clearMessages()
        isUpgrading = true
        defer { isUpgrading = false }

        switch topology {
        case .docker:
            await performDockerUpgrade()
        case .managed:
            await performManagedUpgrade()
        case .local, .remote:
            break // These topologies don't support upgrade from here
        }
    }

    private func performDockerUpgrade() async {
        guard let cli = AppDelegate.shared?.vellumCli else {
            errorMessage = "CLI not available"
            return
        }
        let name = UserDefaults.standard.string(forKey: "connectedAssistantId") ?? ""
        let version = selectedVersion ?? latestRelease?.version
        do {
            try await cli.upgrade(name: name, version: version)
            successMessage = "Upgrade complete."
            await loadReleasesQuietly()
            if successMessage != nil { errorMessage = nil }
        } catch {
            errorMessage = "Upgrade failed: \(error.localizedDescription)"
        }
    }

    private func performManagedUpgrade() async {
        do {
            let body: [String: String] = selectedVersion.map { ["version": $0] } ?? [:]
            let response = try await GatewayHTTPClient.post(path: "assistants/upgrade", json: body)
            if response.isSuccess {
                successMessage = "Upgrade initiated. The assistant may be briefly unavailable."
                // Refresh releases to update UI without clearing success message
                await loadReleasesQuietly()
                // Clear any error from the releases fetch so it doesn't appear alongside the success
                if successMessage != nil { errorMessage = nil }
            } else {
                errorMessage = "Upgrade failed (HTTP \(response.statusCode))"
            }
        } catch let error as GatewayHTTPClient.ClientError {
            errorMessage = "Unable to start upgrade: \(error.localizedDescription)"
        } catch {
            errorMessage = "Upgrade failed: \(error.localizedDescription)"
        }
    }

    // MARK: - Helpers

    private func clearMessages() {
        errorMessage = nil
        successMessage = nil
    }

}

// MARK: - Models

struct AssistantRelease: Decodable, Identifiable {
    let version: String
    let releasedAt: String?
    let assistantImageRef: String?
    let gatewayImageRef: String?
    let credentialExecutorImageRef: String?

    var id: String { version }
}

