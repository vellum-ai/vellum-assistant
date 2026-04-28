import SwiftUI
import VellumAssistantShared

/// Main window toolbar: sidebar toggle, home, search, navigation,
/// coding agents, update button, and conversation title overlay.
struct TopBarView: View {
    @Bindable var windowState: MainWindowState
    var conversationManager: ConversationManager
    var homeStore: HomeStore
    var updateManager: UpdateManager
    var connectionManager: GatewayConnectionManager
    let settingsStore: SettingsStore
    var isInFullscreen: Bool
    let sidebarExpandedWidth: CGFloat
    let sidebarCollapsedWidth: CGFloat
    let onCopyConversation: () -> Void
    let onRenameConversation: () -> Void
    let onOpenForkParent: () -> Void

    @AppStorage("sidebarExpanded") private var sidebarExpanded: Bool = true
    @AppStorage("sidebarToggleShortcut") private var sidebarToggleShortcut: String = "cmd+\\"
    @AppStorage("homeShortcut") private var homeShortcut: String = "cmd+shift+h"

    private var isSettingsOpen: Bool {
        if case .panel(.settings) = windowState.selection { return true }
        if case .panel(.logsAndUsage) = windowState.selection { return true }
        return false
    }

    private var trafficLightPadding: CGFloat {
        isInFullscreen ? VSpacing.lg : 78
    }

    private var sidebarTooltip: String {
        let label = sidebarExpanded ? "Collapse sidebar" : "Expand sidebar"
        guard !sidebarToggleShortcut.isEmpty else { return label }
        let display = ShortcutHelper.displayString(for: sidebarToggleShortcut)
        return "\(label) (\(display))"
    }

    private var homeTooltip: String {
        guard !homeShortcut.isEmpty else { return "Home" }
        return "Home (\(ShortcutHelper.displayString(for: homeShortcut)))"
    }

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            if !isSettingsOpen {
                VButton(label: "Sidebar", iconOnly: VIcon.panelLeft.rawValue, style: .ghost) {
                    withAnimation(VAnimation.panel) {
                        sidebarExpanded.toggle()
                    }
                }
                .vTooltip(sidebarTooltip)

                if MacOSClientFeatureFlagManager.shared.isEnabled("home-tab") {
                    VButton(label: "Home", iconOnly: VIcon.house.rawValue, style: .ghost) {
                        windowState.showPanel(.home)
                    }
                    .overlay(alignment: .topTrailing) {
                        if homeStore.hasUnseenChanges && windowState.selection != .panel(.home) {
                            Circle()
                                .fill(VColor.systemNegativeStrong)
                                .frame(width: 8, height: 8)
                                .offset(x: 2, y: -2)
                                .transition(.scale.combined(with: .opacity))
                                .allowsHitTesting(false)
                                .accessibilityLabel(Text("Unseen changes"))
                        }
                    }
                    .vTooltip(homeTooltip)
                }

                VButton(
                    label: "Coding Agents",
                    iconOnly: VIcon.terminal.rawValue,
                    style: .ghost,
                    isActive: windowState.isRightSlotShowing(.acpSessions)
                ) {
                    windowState.toggleRightSlot(.acpSessions)
                }
                .vTooltip("Coding Agents")

                VButton(label: "Search", iconOnly: VIcon.search.rawValue, style: .ghost) {
                    AppDelegate.shared?.toggleCommandPalette()
                }
                .vTooltip("Search (\u{2318}K)")

                HStack(spacing: 0) {
                    VButton(label: "Back", iconOnly: VIcon.chevronLeft.rawValue, style: .ghost) {
                        windowState.navigateBack()
                    }
                    .disabled(!windowState.canGoBack)
                    .opacity(windowState.canGoBack ? 1 : 0.35)
                    .vTooltip("Back (\u{2318}[)")

                    VButton(label: "Forward", iconOnly: VIcon.chevronRight.rawValue, style: .ghost) {
                        windowState.navigateForward()
                    }
                    .disabled(!windowState.navigationHistory.canGoForward)
                    .opacity(windowState.navigationHistory.canGoForward ? 1 : 0.35)
                    .vTooltip("Forward (\u{2318}])")
                }
            }
            WindowDragArea()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            if updateManager.isUpdateAvailable || updateManager.isServiceGroupUpdateAvailable || updateManager.isDeferredUpdateReady {
                VButton(
                    label: updateManager.isDeferredUpdateReady
                        ? "Restart to update"
                        : (connectionManager.versionMismatch ? "Compatibility update" : "Update"),
                    style: updateManager.isDeferredUpdateReady ? .primary : (connectionManager.versionMismatch ? .outlined : .primary),
                    size: .pill,
                    tooltip: updateManager.isDeferredUpdateReady
                        ? "Restart to install the latest version"
                        : (connectionManager.versionMismatch
                            ? "Your assistant version doesn't match this app"
                            : "A new version is available")
                ) {
                    if updateManager.isDeferredUpdateReady {
                        updateManager.installDeferredUpdateIfAvailable()
                    } else if updateManager.isServiceGroupUpdateAvailable {
                        settingsStore.pendingSettingsTab = .general
                        windowState.selection = .panel(.settings)
                    } else if updateManager.isUpdateAvailable {
                        updateManager.checkForUpdates()
                    }
                }
                .transition(.opacity.combined(with: .scale(scale: 0.9)))
                .animation(VAnimation.fast, value: updateManager.isUpdateAvailable)
                .animation(VAnimation.fast, value: updateManager.isServiceGroupUpdateAvailable)
                .animation(VAnimation.fast, value: updateManager.isDeferredUpdateReady)
            }
        }
        .padding(.leading, trafficLightPadding)
        .padding(.trailing, VSpacing.lg)
        .overlay {
            if windowState.isConversationVisible {
                ConversationTitleOverlay(
                    conversationManager: conversationManager,
                    windowState: windowState,
                    sidebarExpanded: sidebarExpanded,
                    sidebarExpandedWidth: sidebarExpandedWidth,
                    sidebarCollapsedWidth: sidebarCollapsedWidth,
                    isSettingsOpen: isSettingsOpen,
                    onCopy: onCopyConversation,
                    onForkConversation: {
                        Task { await conversationManager.forkActiveConversation() }
                    },
                    onPin: {
                        guard let id = conversationManager.activeConversationId else { return }
                        conversationManager.pinConversation(id: id)
                    },
                    onUnpin: {
                        guard let id = conversationManager.activeConversationId else { return }
                        conversationManager.unpinConversation(id: id)
                    },
                    onArchive: {
                        guard let id = conversationManager.activeConversationId else { return }
                        conversationManager.archiveConversation(id: id)
                    },
                    onRename: onRenameConversation,
                    onOpenForkParent: onOpenForkParent,
                    onAnalyzeConversation: {
                        Task { await conversationManager.analyzeActiveConversation() }
                    },
                    onRefresh: {
                        conversationManager.refreshActiveConversation()
                    },
                    onOpenInNewWindow: conversationManager.activeConversation?.conversationId != nil ? {
                        guard let id = conversationManager.activeConversationId else { return }
                        AppDelegate.shared?.threadWindowManager?.openThread(
                            conversationLocalId: id,
                            conversationManager: conversationManager
                        )
                    } : nil
                )
            }
        }
        .frame(height: 48)
        .background(VColor.surfaceBase)
    }
}
