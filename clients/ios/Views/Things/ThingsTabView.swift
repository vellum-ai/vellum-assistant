#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Entry point for the Things tab — gates on daemon connectivity before
/// showing the main ThingsView with DirectoryStore.
struct ThingsTabView: View {
    @EnvironmentObject var clientProvider: ClientProvider
    var onConnectTapped: (() -> Void)?

    /// Lazily created once by SwiftUI; survives re-renders of this view.
    @StateObject private var directoryStore = LazyDirectoryStore()

    var body: some View {
        if let daemon = clientProvider.client as? DaemonClient, clientProvider.isConnected {
            ThingsView(directoryStore: directoryStore.resolve(daemon: daemon))
                .environmentObject(clientProvider)
        } else {
            ThingsDisconnectedView(onConnectTapped: onConnectTapped)
        }
    }
}

/// Wrapper that lazily creates a `DirectoryStore` once and holds onto it,
/// avoiding repeated allocation on every SwiftUI body evaluation.
@MainActor
private final class LazyDirectoryStore: ObservableObject {
    private var store: DirectoryStore?
    private weak var lastDaemon: DaemonClient?

    func resolve(daemon: DaemonClient) -> DirectoryStore {
        if let store, lastDaemon === daemon { return store }
        let newStore = DirectoryStore(daemonClient: daemon)
        self.store = newStore
        self.lastDaemon = daemon
        return newStore
    }
}

struct ThingsDisconnectedView: View {
    var onConnectTapped: (() -> Void)?

    var body: some View {
        NavigationStack {
            VStack(spacing: VSpacing.lg) {
                VIconView(.layoutGrid, size: 48)
                    .foregroundColor(VColor.textMuted)
                    .accessibilityHidden(true)
                Text("Things Require Connection")
                    .font(VFont.title)
                    .foregroundColor(VColor.textPrimary)
                Text("Connect to your Assistant to browse apps, shared apps, and documents.")
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, VSpacing.xl)
                if onConnectTapped != nil {
                    Button {
                        onConnectTapped?()
                    } label: {
                        Text("Go to Settings")
                    }
                    .buttonStyle(.bordered)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle("Things")
        }
    }
}

#Preview {
    ThingsDisconnectedView()
        .environmentObject(ClientProvider(client: DaemonClient(config: .default)))
}
#endif
