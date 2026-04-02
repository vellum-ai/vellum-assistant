import SwiftUI
import VellumAssistantShared

/// Standalone view for the version mismatch banner overlay, creating a SwiftUI
/// invalidation boundary so changes to unrelated properties on
/// `MainWindowView` don't force this overlay to re-evaluate.
struct MainWindowVersionMismatchBanner: View {
    var connectionManager: GatewayConnectionManager
    var updateManager: UpdateManager
    let settingsStore: SettingsStore
    let windowState: MainWindowState

    var body: some View {
        if connectionManager.versionMismatch && !connectionManager.isUpdateInProgress && !isDismissed {
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
                        },
                        onDismiss: {
                            withAnimation(VAnimation.fast) {
                                connectionManager.dismissVersionMismatch()
                            }
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
                        },
                        onDismiss: {
                            withAnimation(VAnimation.fast) {
                                connectionManager.dismissVersionMismatch()
                            }
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

    /// Whether the user dismissed this specific version mismatch.
    private var isDismissed: Bool {
        guard let key = connectionManager.dismissedMismatchKey,
              let clientVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
              let assistantVersion = connectionManager.assistantVersion else { return false }
        return key == "\(clientVersion)|\(assistantVersion)"
    }

    /// Whether the daemon version is behind the client version.
    private var isDaemonBehind: Bool {
        guard let daemonVersion = connectionManager.assistantVersion,
              let clientVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
              let daemonParsed = VersionCompat.parse(daemonVersion),
              let clientParsed = VersionCompat.parse(clientVersion) else { return false }
        return daemonParsed < clientParsed
    }

    /// Contextual message for version mismatch: tells user which side is behind.
    private var versionMismatchMessage: String {
        guard let daemonVersion = connectionManager.assistantVersion,
              let clientVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
              let daemonParsed = VersionCompat.parse(daemonVersion),
              let clientParsed = VersionCompat.parse(clientVersion) else {
            return "Your app and assistant versions don't match."
        }
        let daemonBehind = daemonParsed < clientParsed
        if daemonBehind {
            return "Your assistant (\(daemonVersion)) doesn't match this app (\(clientVersion)). Update your assistant to match."
        } else {
            return "Your app (\(clientVersion)) is behind the assistant (\(daemonVersion)). Update the app to match."
        }
    }
}
