#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct ContentView: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @Bindable var authManager: AuthManager
    @State private var connectPhase: ConnectPhase = .initial
    @State private var selectedTab: Tab = .home

    private enum Tab { case home, chats, identity, settings }

    private enum ConnectPhase {
        case initial    // Haven't attempted connection yet
        case connecting // Connection in progress
        case failed     // Connection attempt failed
        case ready      // Connected, or no saved settings (show tabs)
    }

    /// Whether the user has previously saved daemon connection settings.
    private var hasSavedSettings: Bool {
        if let url = UserDefaults.standard.string(forKey: "runtime_url"), !url.isEmpty {
            return true
        }
        return UserDefaults.standard.string(forKey: UserDefaultsKeys.daemonHostname) != nil
    }

    var body: some View {
        Group {
            if clientProvider.isConnected || connectPhase == .ready {
                tabContent
            } else if connectPhase == .failed {
                connectionFailedView
            } else {
                connectingView
            }
        }
        .task {
            await authManager.checkSession()
            await attemptInitialConnection()
        }
        .onChange(of: clientProvider.isConnected) { _, connected in
            if connected { connectPhase = .ready }
        }
    }

    // MARK: - Initial Connection

    private func attemptInitialConnection() async {
        guard hasSavedSettings, !clientProvider.isConnected else {
            connectPhase = .ready
            return
        }
        connectPhase = .connecting
        do {
            try await clientProvider.client.connect()
            clientProvider.isConnected = true
            connectPhase = .ready
        } catch {
            connectPhase = .failed
        }
    }

    // MARK: - Connecting Screen

    private var connectingView: some View {
        VStack(spacing: VSpacing.lg) {
            ProgressView()
                .scaleEffect(1.5)
            Text("Connecting to your assistant...")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Connection Failed Screen

    private var connectionFailedView: some View {
        VStack(spacing: VSpacing.lg) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 48))
                .foregroundColor(VColor.textMuted)

            Text("Unable to Connect")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)

            Text("Could not reach your assistant. Check that your Mac is running and try again.")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)

            VStack(spacing: VSpacing.md) {
                Button {
                    Task { await attemptInitialConnection() }
                } label: {
                    Text("Retry")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(VColor.accent)

                Button {
                    selectedTab = .settings
                    connectPhase = .ready
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
            HomeBaseView()
                .environmentObject(clientProvider)
                .id(ObjectIdentifier(clientProvider.client as AnyObject))
                .tag(Tab.home)
                .tabItem {
                    Label("Home", systemImage: "house")
                }

            ThreadListView(daemonClient: clientProvider.client)
                .id(ObjectIdentifier(clientProvider.client as AnyObject))
                .tag(Tab.chats)
                .tabItem {
                    Label("Chats", systemImage: "message")
                }

            IdentityView()
                .environmentObject(clientProvider)
                .id(ObjectIdentifier(clientProvider.client as AnyObject))
                .tag(Tab.identity)
                .tabItem {
                    Label("Identity", systemImage: "person.text.rectangle")
                }

            SettingsView(authManager: authManager)
                .environmentObject(clientProvider)
                .tag(Tab.settings)
                .tabItem {
                    Label("Settings", systemImage: "gear")
                }
        }
    }
}

#Preview {
    ContentView(authManager: AuthManager())
        .environmentObject(ClientProvider(client: DaemonClient(config: .default)))
}
#endif
