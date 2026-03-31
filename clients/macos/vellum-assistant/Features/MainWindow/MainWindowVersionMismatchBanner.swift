import SwiftUI
import VellumAssistantShared

/// Standalone view for the version mismatch banner overlay, creating a SwiftUI
/// invalidation boundary so changes to unrelated `@ObservedObject`s on
/// `MainWindowView` don't force this overlay to re-evaluate.
struct MainWindowVersionMismatchBanner: View {
    @ObservedObject var connectionManager: GatewayConnectionManager
    @ObservedObject var updateManager: UpdateManager
    let settingsStore: SettingsStore
    let windowState: MainWindowState

    var body: some View {
        if connectionManager.versionMismatch && !connectionManager.isUpdateInProgress {
            // Suppress when the "Update" pill already covers it (daemon behind + update available)
            if !(updateManager.isServiceGroupUpdateAvailable && isDaemonBehind) {
                if isDaemonBehind {
                    ChatConversationErrorToast(
                        message: versionMismatchMessage,
                        icon: .triangleAlert,
                        accentColor: VColor.systemMidStrong,
                        actionLabel: "Update in Settings",
                        onAction: {
                            settingsStore.pendingSettingsTab = .general
                            windowState.selection = .panel(.settings)
                        }
                    )
                    .containerRelativeFrame(.horizontal) { width, _ in width * 0.7 }
                    .padding(.top, VSpacing.sm)
                    .animation(VAnimation.fast, value: connectionManager.versionMismatch)
                } else {
                    ChatConversationErrorToast(
                        message: versionMismatchMessage,
                        icon: .triangleAlert,
                        accentColor: VColor.systemMidStrong,
                        actionLabel: "Check for App Update",
                        onAction: {
                            AppDelegate.shared?.updateManager.checkForUpdates()
                        }
                    )
                    .containerRelativeFrame(.horizontal) { width, _ in width * 0.7 }
                    .padding(.top, VSpacing.sm)
                    .animation(VAnimation.fast, value: connectionManager.versionMismatch)
                }
            }
        }
    }

    // MARK: - Helpers

    /// Whether the daemon version is behind the client version.
    private var isDaemonBehind: Bool {
        guard let daemonVersion = connectionManager.assistantVersion,
              let clientVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
              let daemonParsed = VersionCompat.parse(daemonVersion),
              let clientParsed = VersionCompat.parse(clientVersion) else { return false }
        if daemonParsed.major != clientParsed.major { return daemonParsed.major < clientParsed.major }
        if daemonParsed.minor != clientParsed.minor { return daemonParsed.minor < clientParsed.minor }
        return daemonParsed.patch < clientParsed.patch
    }

    /// Contextual message for version mismatch: tells user which side is behind.
    private var versionMismatchMessage: String {
        guard let daemonVersion = connectionManager.assistantVersion,
              let clientVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
              let daemonParsed = VersionCompat.parse(daemonVersion),
              let clientParsed = VersionCompat.parse(clientVersion) else {
            return "Your app and assistant versions don't match."
        }
        let daemonBehind: Bool = {
            if daemonParsed.major != clientParsed.major { return daemonParsed.major < clientParsed.major }
            if daemonParsed.minor != clientParsed.minor { return daemonParsed.minor < clientParsed.minor }
            return daemonParsed.patch < clientParsed.patch
        }()
        if daemonBehind {
            return "Your assistant (\(daemonVersion)) doesn't match this app (\(clientVersion)). Update your assistant to match."
        } else {
            return "Your app (\(clientVersion)) is behind the assistant (\(daemonVersion)). Update the app to match."
        }
    }
}
