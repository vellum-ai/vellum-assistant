import Foundation
import SwiftUI
import VellumAssistantShared

/// Upgrade section for managed/remote assistants.
///
/// Shows the current version, checks for available releases, and provides
/// an "Upgrade Now" button to trigger a platform-side upgrade.
/// Only displayed when the assistant is managed (`isManaged == true`).
@MainActor
struct AssistantUpgradeSection: View {
    let currentVersion: String?

    @State private var availableReleases: [AssistantRelease] = []
    @State private var isLoadingReleases = false
    @State private var isUpgrading = false
    @State private var errorMessage: String?
    @State private var successMessage: String?
    @State private var showingUpgradeConfirmation = false

    private var latestRelease: AssistantRelease? {
        availableReleases.first
    }

    private var upgradeAvailable: Bool {
        guard let latest = latestRelease, let current = currentVersion, !current.isEmpty else { return false }
        return latest.version != current
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

                if let latest = latestRelease {
                    HStack(spacing: VSpacing.sm) {
                        Text("Latest version:")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                        Text(latest.version)
                            .font(VFont.mono)
                            .foregroundColor(upgradeAvailable ? VColor.primaryBase : VColor.contentDefault)
                    }
                }

                if !upgradeAvailable && !isLoadingReleases && !availableReleases.isEmpty {
                    Text("You are on the latest version.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.systemPositiveStrong)
                }
            }

            HStack(spacing: VSpacing.md) {
                VButton(
                    label: isUpgrading ? "Upgrading..." : "Upgrade Now",
                    style: .primary
                ) {
                    showingUpgradeConfirmation = true
                }
                .disabled(!upgradeAvailable || isUpgrading)

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
        .alert("Upgrade Assistant", isPresented: $showingUpgradeConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Upgrade") {
                Task { await performUpgrade() }
            }
        } message: {
            if let latest = latestRelease {
                Text("Upgrade to version \(latest.version)? The assistant will be briefly unavailable during the upgrade.")
            } else {
                Text("Upgrade to the latest version? The assistant will be briefly unavailable.")
            }
        }
    }

    // MARK: - Actions

    private func loadReleases() async {
        clearMessages()
        await loadReleasesQuietly()
    }

    /// Fetches releases without clearing existing messages.
    private func loadReleasesQuietly() async {
        isLoadingReleases = true
        defer { isLoadingReleases = false }

        do {
            let (paginated, response): (PaginatedReleasesResponse?, _) = try await GatewayHTTPClient.get(
                path: "assistants/releases"
            ) { $0.keyDecodingStrategy = .convertFromSnakeCase }
            guard response.statusCode == 200 else {
                errorMessage = "Failed to check for updates"
                return
            }
            if let paginated {
                availableReleases = paginated.results
            } else {
                let decoder = JSONDecoder()
                decoder.keyDecodingStrategy = .convertFromSnakeCase
                if let decoded = try? decoder.decode(ReleasesResponse.self, from: response.data) {
                    availableReleases = decoded.releases
                } else {
                    availableReleases = try decoder.decode([AssistantRelease].self, from: response.data)
                }
            }
        } catch let error as GatewayHTTPClient.ClientError {
            errorMessage = "Unable to check for updates: \(error.localizedDescription)"
        } catch {
            errorMessage = "Failed to check for updates: \(error.localizedDescription)"
        }
    }

    private func performUpgrade() async {
        clearMessages()
        isUpgrading = true
        defer { isUpgrading = false }

        do {
            let response = try await GatewayHTTPClient.post(path: "assistants/upgrade")
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

    var id: String { version }
}

private struct ReleasesResponse: Decodable {
    let releases: [AssistantRelease]
}

private struct PaginatedReleasesResponse: Decodable {
    let results: [AssistantRelease]
}
