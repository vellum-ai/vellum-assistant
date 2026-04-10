import SwiftUI
import VellumAssistantShared

// MARK: - Drawer Layers

extension MainWindowView {

    @ViewBuilder
    var preferencesDismissLayer: some View {
        if sidebar.showPreferencesDrawer {
            Color.clear
                .contentShape(Rectangle())
                .onTapGesture {
                    withAnimation(VAnimation.snappy) {
                        sidebar.showPreferencesDrawer = false
                    }
                }
        }
    }

    @ViewBuilder
    var preferencesDrawerLayer: some View {
        if sidebar.showPreferencesDrawer {
            let drawerWidth = sidebarExpandedWidth - VSpacing.sm * 2
            let bottomPad: CGFloat = 16 + (sidebarExpanded ? VSpacing.md : VSpacing.sm)
            // Position above the PreferencesRow: clear the row height + divider + gap
            let dividerHeight: CGFloat = 1 + SidebarLayoutMetrics.dividerVerticalPadding * 2
            let drawerY = bottomPad + SidebarLayoutMetrics.rowMinHeight + dividerHeight + VSpacing.xs
            DrawerMenuView(
                authManager: authManager,
                onSettings: {
                    sidebar.showPreferencesDrawer = false
                    windowState.selection = .panel(.settings)
                },
                onUsage: {
                    sidebar.showPreferencesDrawer = false
                    windowState.selection = .panel(.usageDashboard)
                },
                onDebug: {
                    sidebar.showPreferencesDrawer = false
                    windowState.selection = .panel(.debug)
                },
                onShareFeedback: {
                    sidebar.showPreferencesDrawer = false
                    AppDelegate.shared?.sendFeedback()
                },
                onLogOut: {
                    sidebar.showPreferencesDrawer = false
                    AppDelegate.shared?.performLogout()
                },
                onSignIn: {
                    sidebar.showPreferencesDrawer = false
                    Task {
                        await authManager.loginWithToast(showToast: { msg, style in
                            windowState.showToast(message: msg, style: style)
                        }, onSuccess: {
                            // Re-bootstrap actor credentials and local assistant API key
                            // so the app can authenticate to the local assistant again.
                            // Mirrors the pattern in SettingsPanel and proceedToApp().
                            if !(AppDelegate.shared?.isCurrentAssistantManaged ?? false) {
                                AppDelegate.shared?.ensureActorCredentials()
                            }
                            AppDelegate.shared?.localBootstrapDidComplete = false
                            AppDelegate.shared?.ensureLocalAssistantApiKey()

                            // For managed assistants, re-establish the connection now that
                            // the user has a valid session token.
                            if AppDelegate.shared?.isCurrentAssistantManaged ?? false {
                                AppDelegate.shared?.reconnectManagedAssistant()
                            }
                        })
                    }
                },
                onOpenBilling: {
                    sidebar.showPreferencesDrawer = false
                    settingsStore.pendingSettingsTab = .billing
                    windowState.selection = .panel(.settings)
                },
                onEarnCredits: {
                    sidebar.showPreferencesDrawer = false
                    showEarnCreditsModal = true
                }
            )
            .frame(width: drawerWidth)
            .offset(x: 16 + VSpacing.sm, y: -drawerY)
            .animation(VAnimation.snappy, value: sidebarExpanded)
            .zIndex(10)
            .transition(.scale(scale: 0.96, anchor: .bottom).combined(with: .opacity))
        }
    }

    @ViewBuilder
    var conversationSwitcherDismissLayer: some View {
        if showConversationSwitcher {
            Color.clear
                .contentShape(Rectangle())
                .onTapGesture {
                    showConversationSwitcher = false
                }
        }
    }

    @ViewBuilder
    var conversationSwitcherDrawerLayer: some View {
        if showConversationSwitcher {
            ConversationSwitcherDrawer(
                conversationManager: conversationManager,
                windowState: windowState,
                sidebar: sidebar,
                customGroupsEnabled: assistantFeatureFlagStore.isEnabled("conversation-groups-ui"),
                selectConversation: { selectConversation($0) },
                onDismiss: { showConversationSwitcher = false }
            )
            .frame(width: sidebarExpandedWidth - VSpacing.sm * 2)
            .offset(
                x: 16 + sidebarCollapsedWidth - VSpacing.xs,
                y: conversationSwitcherTriggerFrame.minY
            )
            .zIndex(10)
            .transition(.opacity)
            .onChange(of: conversationManager.activeConversationId) { _, _ in
                showConversationSwitcher = false
            }
            .onChange(of: sidebarExpanded) { _, expanded in
                if expanded { showConversationSwitcher = false }
            }
        }
    }
}
