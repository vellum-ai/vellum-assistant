#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct ContentView: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @Bindable var authManager: AuthManager
    @State private var connectPhase: ConnectPhase = .initial
    @State private var selectedTab: Tab = .chats
    /// Single conversation store shared between the Chats tab and the Developer section's
    /// diagnostics. Keeping one store prevents the dual-store data-loss race where two
    /// independent stores each overwrite the other's UserDefaults writes in standalone mode.
    @StateObject private var conversationStore: IOSConversationStore

    init(authManager: AuthManager, connectionManager: GatewayConnectionManager, eventStreamClient: EventStreamClient) {
        self.authManager = authManager
        _conversationStore = StateObject(wrappedValue: IOSConversationStore(connectionManager: connectionManager, eventStreamClient: eventStreamClient))
    }

    private enum Tab { case chats, settings }

    private enum ConnectPhase {
        case initial    // Haven't attempted connection yet
        case connecting // Connection in progress
        case failed     // Connection attempt failed
        case ready      // Connected, or no saved settings (show tabs)
    }

    /// Whether the user has previously saved daemon connection settings.
    /// iOS uses HTTP+SSE only — checks for managed assistant, gateway URL, or runtime URL.
    private var hasSavedSettings: Bool {
        if let id = UserDefaults.standard.string(forKey: UserDefaultsKeys.managedAssistantId), !id.isEmpty,
           let url = UserDefaults.standard.string(forKey: UserDefaultsKeys.managedPlatformBaseURL), !url.isEmpty {
            return true
        }
        if let url = UserDefaults.standard.string(forKey: UserDefaultsKeys.gatewayBaseURL), !url.isEmpty {
            return true
        }
        if let url = UserDefaults.standard.string(forKey: "runtime_url"), !url.isEmpty {
            return true
        }
        return false
    }

    var body: some View {
        Group {
            if clientProvider.isConnected || connectPhase == .ready {
                tabContent
            } else if connectPhase == .failed {
                connectionFailedView
            } else if hasSavedSettings {
                connectingView
            } else {
                // No saved settings — show tabs immediately so the user
                // can navigate to Settings and configure their connection.
                tabContent
            }
        }
        .task {
            // Consume any push-notification tap that arrived before this view's
            // `.onReceive` subscriber was attached (cold launch from notification).
            // The hot path is handled by `.onReceive` below; this covers the race.
            consumePendingPushNavigationIfNeeded()
            await authManager.checkSession()
            await attemptInitialConnection()
        }
        .onChange(of: clientProvider.isConnected) { _, connected in
            if connected { connectPhase = .ready }
        }
        // Re-attempt connect when the user finishes signing in mid-session.
        // The initial connect in `.task` runs before `AuthManager` has a session token,
        // so the health check returns `Not authenticated`. Without this observer the
        // connection manager stays stale-disconnected until a background→foreground
        // transition, and every `MessageSendCoordinator.sendUserMessage` buffers to the
        // offline queue. Routing through `attemptInitialConnection()` keeps the
        // `connectPhase` / `retryCount` state machine in sync on both success and
        // failure, so a post-auth connect failure surfaces the same retry UI as a
        // cold-launch connect failure.
        .onChange(of: authManager.isAuthenticated) { _, nowAuthenticated in
            guard nowAuthenticated, !clientProvider.isConnected else { return }
            Task { @MainActor in
                await attemptInitialConnection()
            }
        }
        // When rebuildClient() replaces the GatewayConnectionManager, re-bind the conversation store
        // to the new client so it doesn't keep targeting the old disconnected daemon.
        // ObjectIdentifier changes whenever the client object is replaced.
        .onChange(of: ObjectIdentifier(clientProvider.client as AnyObject)) { _, _ in
            conversationStore.rebindGatewayConnectionManager(clientProvider.client, eventStreamClient: clientProvider.eventStreamClient)
        }
        // Push notification tap: AppDelegate.userNotificationCenter(_:didReceive:) posts
        // this notification on the default action with the conversation ID in userInfo.
        // Switch to the Chats tab and ask the store to select the conversation. The store
        // handles the deferred case (cold start / cache miss) by holding the ID until the
        // conversation list loads.
        .onReceive(NotificationCenter.default.publisher(for: .iosPushNotificationConversationTap)) { notification in
            guard let conversationId = notification.userInfo?[iosPushNotificationConversationIdKey] as? String else { return }
            // Clear the cold-start latch so the `.task` fallback doesn't re-apply
            // this navigation when the view later appears (e.g. if the app was
            // backgrounded and ContentView.task re-runs on re-entry).
            _ = PendingPushNavigation.consume()
            selectedTab = .chats
            conversationStore.requestSelectConversation(conversationId: conversationId)
        }
    }

    /// Consume the cold-start push-tap latch set by `AppDelegate.userNotificationCenter(_:didReceive:)`
    /// when the delegate callback fires before this view's `.onReceive` subscriber is attached.
    /// No-op when the latch is empty (hot path already handled the tap via `.onReceive`).
    private func consumePendingPushNavigationIfNeeded() {
        guard let conversationId = PendingPushNavigation.consume() else { return }
        selectedTab = .chats
        conversationStore.requestSelectConversation(conversationId: conversationId)
    }

    private func navigateToConnectSettings() {
        // Connection status lives inline in the Settings tab — see
        // `ConnectionInfoSection`. Switching to the tab is sufficient; there
        // is no longer a subscreen to push into.
        selectedTab = .settings
    }

    private func navigateToNewConversation() {
        selectedTab = .chats
    }

    // MARK: - Initial Connection

    /// How many consecutive connection failures have occurred (used for exponential backoff on retry).
    @State private var retryCount: Int = 0

    private func attemptInitialConnection() async {
        guard hasSavedSettings, !clientProvider.isConnected else {
            connectPhase = .ready
            return
        }
        connectPhase = .connecting

        // Apply exponential backoff when retrying: 0s, 2s, 4s, 8s … capped at 30s.
        if retryCount > 0 {
            let delaySeconds = min(pow(2.0, Double(retryCount - 1)) * 2.0, 30.0)
            try? await Task.sleep(nanoseconds: UInt64(delaySeconds * 1_000_000_000))
        }

        // Race the connect call against a 10-second timeout so a hung gateway
        // never leaves the UI stuck on the spinner indefinitely.
        let connectTask = Task { try await clientProvider.client.connect() }
        let timeoutTask = Task {
            try await Task.sleep(nanoseconds: 10_000_000_000)
            connectTask.cancel()
        }

        do {
            try await connectTask.value
            timeoutTask.cancel()
            retryCount = 0
            clientProvider.isConnected = true
            connectPhase = .ready
        } catch {
            timeoutTask.cancel()
            retryCount += 1
            connectPhase = .failed
        }
    }

    // MARK: - Connecting Screen

    private var connectingView: some View {
        VStack(spacing: VSpacing.lg) {
            ProgressView()
                .scaleEffect(1.5)
            Text("Connecting to your Assistant...")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Connection Failed Screen

    private var connectionFailedView: some View {
        VStack(spacing: VSpacing.lg) {
            VIconView(.wifiOff, size: 48)
                .foregroundStyle(VColor.contentTertiary)

            Text("Unable to Connect")
                .font(VFont.titleMedium)
                .foregroundStyle(VColor.contentDefault)

            Text("Unable to reach your Assistant's gateway. This could mean your Assistant is offline, the tunnel is down, or the gateway is not active.")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)

            if retryCount > 1 {
                let delaySeconds = Int(min(pow(2.0, Double(retryCount - 1)) * 2.0, 30.0))
                Text("Retrying in \(delaySeconds)s…")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }

            VStack(spacing: VSpacing.md) {
                Button {
                    Task { await attemptInitialConnection() }
                } label: {
                    Text("Retry")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(VColor.primaryBase)

                Button {
                    connectPhase = .ready
                    navigateToConnectSettings()
                } label: {
                    Text("Go to Settings")
                }
                .buttonStyle(.bordered)
            }
            .padding(.horizontal, VSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Tab Content

    private var tabContent: some View {
        TabView(selection: $selectedTab) {
            ChatsTabView(store: conversationStore, onConnectTapped: navigateToConnectSettings)
                .environmentObject(clientProvider)
                .id(ObjectIdentifier(clientProvider.client as AnyObject))
                .tag(Tab.chats)
                .tabItem {
                    Label { Text("Chats") } icon: { VIconView(.messageSquare, size: 12) }
                }

            SettingsView(authManager: authManager, conversationStore: conversationStore)
                .environmentObject(clientProvider)
                .tag(Tab.settings)
                .tabItem {
                    Label { Text("Settings") } icon: { VIconView(.settings, size: 12) }
                }
        }
    }
}
#endif
