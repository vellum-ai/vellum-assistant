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

/// Upgrade and rollback section shown for all assistant topologies.
///
/// Shows the current version, available releases via a version picker,
/// and topology-appropriate actions (CLI upgrade for Docker, platform API
/// for managed, Sparkle for local, informational for remote).
@MainActor
struct AssistantUpgradeSection: View {
    let currentVersion: String?
    let topology: AssistantTopology

    @Binding var isDockerOperationInProgress: Bool
    @Binding var dockerOperationLabel: String

    /// Whether a Sparkle update is available (local topology only).
    var sparkleUpdateAvailable: Bool = false
    /// The version Sparkle would upgrade to (local topology only).
    var sparkleUpdateVersion: String?

    /// Whether a service group update is in progress (managed topology).
    var isServiceGroupUpdateInProgress: Bool = false

    @State private var availableReleases: [AssistantRelease] = []
    @State private var selectedVersion: String?
    @State private var isLoadingReleases = false
    @State private var isUpgrading = false
    @State private var errorMessage: String?
    @State private var successMessage: String?
    @State private var showingUpgradeConfirmation = false
    @State private var showFeedbackOption = false
    @State private var isCheckingLocal = false
    @State private var hasCheckedForUpdates = false
    @State private var checkedSparkleAvailable: Bool?
    @State private var checkedSparkleVersion: String?
    @State private var isTakingLongerThanExpected = false
    @State private var escalationTask: Task<Void, Never>?

    private var latestRelease: AssistantRelease? {
        availableReleases.first
    }

    private var effectiveSelectedVersion: String? {
        selectedVersion ?? latestRelease?.version
    }

    private var upgradeAvailable: Bool {
        guard let target = effectiveSelectedVersion,
              let current = currentVersion, !current.isEmpty else { return false }
        guard let targetParsed = VersionCompat.parse(target),
              let currentParsed = VersionCompat.parse(current) else {
            // Fall back to string comparison if versions can't be parsed
            return target != current
        }
        return targetParsed.major != currentParsed.major
            || targetParsed.minor != currentParsed.minor
            || targetParsed.patch != currentParsed.patch
    }

    /// Whether the selected target version is older than the current version.
    private var isRollback: Bool {
        guard let target = effectiveSelectedVersion,
              let current = currentVersion, !current.isEmpty,
              let targetParsed = VersionCompat.parse(target),
              let currentParsed = VersionCompat.parse(current) else {
            return false
        }
        if targetParsed.major != currentParsed.major { return targetParsed.major < currentParsed.major }
        if targetParsed.minor != currentParsed.minor { return targetParsed.minor < currentParsed.minor }
        return targetParsed.patch < currentParsed.patch
    }

    /// Human-readable label for the current topology.
    private var topologySubtitle: String {
        switch topology {
        case .local: return "Local"
        case .docker: return "Docker"
        case .managed: return "Managed"
        case .remote: return "Remote"
        }
    }

    /// The client app version from the bundle (always available).
    private var appVersion: String? {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
    }

    /// Whether the client and service group versions are incompatible (different major.minor).
    private var isVersionIncompatible: Bool {
        guard let sgVersion = currentVersion, !sgVersion.isEmpty,
              let clientVersion = appVersion else { return false }
        return !VersionCompat.isCompatible(clientVersion: clientVersion, serviceGroupVersion: sgVersion)
    }

    /// Whether the service group version is older than the client version.
    private var isServiceGroupBehind: Bool {
        guard let sgVersion = currentVersion, !sgVersion.isEmpty,
              let clientVersion = appVersion,
              let sgParsed = VersionCompat.parse(sgVersion),
              let clientParsed = VersionCompat.parse(clientVersion) else { return false }
        if sgParsed.major != clientParsed.major { return sgParsed.major < clientParsed.major }
        if sgParsed.minor != clientParsed.minor { return sgParsed.minor < clientParsed.minor }
        return sgParsed.patch < clientParsed.patch
    }

    var body: some View {
        SettingsCard(title: "Assistant Version", subtitle: topologySubtitle) {
            // Version info — always visible
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                if topology == .local {
                    // Local: app and service group are bundled, show single version
                    if let version = appVersion {
                        HStack(spacing: VSpacing.sm) {
                            Text("Version:")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                            Text(version)
                                .font(VFont.mono)
                                .foregroundColor(VColor.contentDefault)
                        }
                    }
                } else {
                    // Docker/managed/remote: show both app and service group versions
                    if let version = appVersion {
                        HStack(spacing: VSpacing.sm) {
                            Text("App version:")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                            Text(version)
                                .font(VFont.mono)
                                .foregroundColor(VColor.contentDefault)
                        }
                    }
                    HStack(spacing: VSpacing.sm) {
                        Text("Service group:")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                        if let sgVersion = currentVersion, !sgVersion.isEmpty {
                            Text(sgVersion)
                                .font(VFont.mono)
                                .foregroundColor(isVersionIncompatible ? VColor.systemNegativeStrong : VColor.contentDefault)
                        } else {
                            Text("Loading...")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                        }
                    }
                }
            }

            // Version mismatch warning (non-local topologies only)
            if isVersionIncompatible && topology != .local {
                if isServiceGroupBehind {
                    VInlineMessage(
                        "Your assistant is on an older version and may not work correctly with this app. Update to match.",
                        tone: .warning
                    )
                } else {
                    VInlineMessage(
                        "Your app is older than the assistant. Update the app to ensure compatibility.",
                        tone: .warning
                    )
                }
            }

            // Update status
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                if topology == .local {
                    let effectiveAvailable = checkedSparkleAvailable ?? sparkleUpdateAvailable
                    let effectiveVersion = checkedSparkleVersion ?? sparkleUpdateVersion
                    if effectiveAvailable, let updateVersion = effectiveVersion {
                        HStack(spacing: VSpacing.sm) {
                            Text("Update available:")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                            Text(updateVersion)
                                .font(VFont.mono)
                                .foregroundColor(VColor.primaryBase)
                        }
                    } else if hasCheckedForUpdates && !effectiveAvailable {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.circleCheck, size: 12)
                                .foregroundColor(VColor.systemPositiveStrong)
                            Text("You are on the latest version.")
                                .font(VFont.caption)
                                .foregroundColor(VColor.systemPositiveStrong)
                        }
                    }

                    if isCheckingLocal {
                        HStack(spacing: VSpacing.sm) {
                            ProgressView()
                                .controlSize(.small)
                            Text("Checking for updates...")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                        }
                    }
                }

                if !availableReleases.isEmpty && topology != .remote && topology != .local {
                    HStack(spacing: VSpacing.sm) {
                        Text(isRollback ? "Roll back to:" : "Update to:")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                        Picker("", selection: Binding<String>(
                            get: { selectedVersion ?? latestRelease?.version ?? "" },
                            set: { newValue in
                                selectedVersion = (newValue == latestRelease?.version) ? nil : newValue
                            }
                        )) {
                            ForEach(availableReleases) { release in
                                Text(releaseLabel(for: release)).tag(release.version)
                            }
                        }
                        .pickerStyle(.menu)
                    }
                }

                if !upgradeAvailable && !isLoadingReleases && !availableReleases.isEmpty && topology != .local {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.circleCheck, size: 12)
                            .foregroundColor(VColor.systemPositiveStrong)
                        Text(selectedVersion == nil
                             ? "You are on the latest version."
                             : "You are already on this version.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.systemPositiveStrong)
                    }
                }

                if availableReleases.isEmpty && !isLoadingReleases && errorMessage == nil && topology != .local {
                    Text("No releases available.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
            }

            if topology == .remote {
                HStack(spacing: VSpacing.xs) {
                    VIconView(.triangleAlert, size: 12)
                        .foregroundColor(VColor.systemMidStrong)
                    Text("Automatic updates are not available for this deployment. Update your infrastructure manually.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
            }

            HStack(spacing: VSpacing.md) {
                if topology == .local {
                    VButton(
                        label: isCheckingLocal ? "Checking..." : "Check for Updates",
                        style: .outlined,
                        isDisabled: isCheckingLocal
                    ) {
                        Task {
                            isCheckingLocal = true
                            if let manager = AppDelegate.shared?.updateManager {
                                let available = await manager.checkForUpdatesAsync()
                                checkedSparkleAvailable = available
                                checkedSparkleVersion = manager.availableUpdateVersion
                            }
                            hasCheckedForUpdates = true
                            isCheckingLocal = false
                        }
                    }
                } else if topology != .remote {
                    // Docker and managed get the upgrade button
                    VButton(
                        label: isUpgrading
                            ? (isRollback ? "Rolling back..." : "Updating...")
                            : (isRollback ? "Roll Back" : "Update Now"),
                        style: isRollback ? .outlined : .primary
                    ) {
                        showingUpgradeConfirmation = true
                    }
                    .disabled(!upgradeAvailable || isUpgrading)
                }

                if topology != .local && topology != .remote {
                    VButton(
                        label: isLoadingReleases ? "Checking..." : "Check for Updates",
                        style: .outlined
                    ) {
                        Task { await loadReleases() }
                    }
                    .disabled(isLoadingReleases || isUpgrading)
                }
            }

            if isLoadingReleases || isUpgrading {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text(isUpgrading ? (isRollback ? "Rolling back assistant..." : "Updating assistant...") : "Checking for updates...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
            }

            if let error = errorMessage {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.systemNegativeStrong)
            }

            if showFeedbackOption {
                VButton(label: "Share Feedback", style: .outlined) {
                    AppDelegate.shared?.showLogReportWindow(reason: .somethingBroken)
                }
            }

            if let success = successMessage {
                Text(success)
                    .font(VFont.caption)
                    .foregroundColor(VColor.systemPositiveStrong)
            }

            if isServiceGroupUpdateInProgress && !isUpgrading && topology == .managed {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text(isTakingLongerThanExpected
                        ? "Taking longer than expected. The assistant may still be updating..."
                        : "Assistant is updating...")
                        .font(VFont.caption)
                        .foregroundStyle(isTakingLongerThanExpected ? VColor.systemMidStrong : VColor.contentTertiary)
                }
            }
        }
        .task { await loadReleases() }
        .onChange(of: currentVersion) { _, _ in
            Task { await loadReleasesQuietly() }
        }
        .onChange(of: isServiceGroupUpdateInProgress) { _, inProgress in
            if inProgress {
                isTakingLongerThanExpected = false
                escalationTask = Task {
                    try? await Task.sleep(nanoseconds: 90 * 1_000_000_000)
                    if !Task.isCancelled {
                        isTakingLongerThanExpected = true
                    }
                }
            } else {
                escalationTask?.cancel()
                escalationTask = nil
                isTakingLongerThanExpected = false
            }
        }
        .alert(isRollback ? "Roll Back Assistant" : "Update Assistant", isPresented: $showingUpgradeConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button(isRollback ? "Roll Back" : "Update") {
                Task { await performUpgrade() }
            }
        } message: {
            if isRollback {
                Text("Roll back to version \(effectiveSelectedVersion ?? "unknown")? The assistant will be briefly unavailable.")
            } else {
                Text("Update to version \(effectiveSelectedVersion ?? "latest")? The assistant will be briefly unavailable during the update.")
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
            // Reset selection if the previously selected version is no longer in the list
            if let selected = selectedVersion,
               !availableReleases.contains(where: { $0.version == selected }) {
                selectedVersion = nil
            }
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
        dockerOperationLabel = isRollback ? "Rolling back assistant..." : "Updating assistant..."
        isDockerOperationInProgress = true
        defer { isDockerOperationInProgress = false }
        do {
            try await cli.upgrade(name: name, version: version)
            successMessage = isRollback ? "Rollback complete." : "Update complete."
            AppDelegate.shared?.updateManager.clearServiceGroupFlags()
            showFeedbackOption = false
            await loadReleasesQuietly()
            if successMessage != nil { errorMessage = nil }
        } catch let error as VellumCli.CLIError {
            switch error {
            case .structuredError(let cliError):
                errorMessage = guidanceForError(cliError)
                showFeedbackOption = true
            case .executionFailed(let stderr):
                errorMessage = "\(isRollback ? "Rollback" : "Update") failed: \(stderr)"
                showFeedbackOption = true
            default:
                errorMessage = "\(isRollback ? "Rollback" : "Update") failed: \(error.localizedDescription)"
            }
        } catch {
            errorMessage = "\(isRollback ? "Rollback" : "Update") failed: \(error.localizedDescription)"
        }
    }

    private func performManagedUpgrade() async {
        do {
            let version = selectedVersion ?? latestRelease?.version
            let body: [String: String] = version.map { ["version": $0] } ?? [:]
            let response = try await GatewayHTTPClient.post(path: "assistants/upgrade", json: body)
            if response.isSuccess {
                successMessage = isRollback
                    ? "Rollback initiated. The assistant may be briefly unavailable."
                    : "Update initiated. The assistant may be briefly unavailable."
                AppDelegate.shared?.updateManager.clearServiceGroupFlags()
                showFeedbackOption = false
                // Refresh releases to update UI without clearing success message
                await loadReleasesQuietly()
                // Clear any error from the releases fetch so it doesn't appear alongside the success
                if successMessage != nil { errorMessage = nil }
            } else {
                errorMessage = "\(isRollback ? "Rollback" : "Update") failed (HTTP \(response.statusCode))"
                showFeedbackOption = true
            }
        } catch let error as GatewayHTTPClient.ClientError {
            errorMessage = "Unable to start \(isRollback ? "rollback" : "update"): \(error.localizedDescription)"
            showFeedbackOption = true
        } catch {
            errorMessage = "\(isRollback ? "Rollback" : "Update") failed: \(error.localizedDescription)"
            showFeedbackOption = true
        }
    }

    // MARK: - Helpers

    /// Build a display label for a release in the version picker,
    /// annotating with "(latest)" and/or "(current)" as appropriate.
    private func releaseLabel(for release: AssistantRelease) -> String {
        let isCurrent: Bool = {
            guard let cv = currentVersion,
                  let currentParsed = VersionCompat.parse(cv),
                  let releaseParsed = VersionCompat.parse(release.version) else {
                return false
            }
            return releaseParsed.major == currentParsed.major
                && releaseParsed.minor == currentParsed.minor
                && releaseParsed.patch == currentParsed.patch
        }()
        let isLatest = release.version == latestRelease?.version
        var parts = [release.version]
        if isLatest { parts.append("(latest)") }
        if isCurrent { parts.append("(current)") }
        return parts.joined(separator: " ")
    }

    private func clearMessages() {
        errorMessage = nil
        successMessage = nil
        showFeedbackOption = false
    }

    private func guidanceForError(_ error: VellumCli.CliError) -> String {
        switch error.category {
        case "DOCKER_NOT_RUNNING":
            return "Docker doesn't appear to be running. Start Docker Desktop and try again."
        case "IMAGE_PULL_FAILED":
            return "Failed to download the update. Check your internet connection and try again."
        case "READINESS_TIMEOUT":
            return "The assistant didn't start up in time. Check Docker Desktop for container status, or try rolling back."
        case "ROLLBACK_FAILED":
            return "Rollback failed. Check Docker Desktop for container status."
        case "ROLLBACK_NO_STATE":
            return "No previous version available to roll back to."
        case "AUTH_FAILED":
            return "Authentication failed. Try signing out and back in from Settings."
        case "NETWORK_ERROR":
            return "Couldn't reach the update server. Check your internet connection."
        case "PLATFORM_API_ERROR":
            return "The platform returned an error. Try again in a few minutes."
        case "ASSISTANT_NOT_FOUND":
            return "Could not find the assistant. Make sure it's still configured."
        case "UNSUPPORTED_TOPOLOGY":
            return "This assistant type doesn't support automatic updates. Update your infrastructure manually."
        default:
            return "Something went wrong. Share feedback to send logs to the team."
        }
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

