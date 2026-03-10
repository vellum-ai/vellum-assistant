#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Entry point for the Things tab — gates on daemon connectivity before
/// showing the main ThingsView with DirectoryStore.
struct ThingsTabView: View {
    @EnvironmentObject var clientProvider: ClientProvider
    var onConnectTapped: (() -> Void)?

    var body: some View {
        if let daemon = clientProvider.client as? DaemonClient, clientProvider.isConnected {
            ThingsView(directoryStore: DirectoryStore(daemonClient: daemon))
                .environmentObject(clientProvider)
        } else {
            ThingsDisconnectedView(onConnectTapped: onConnectTapped)
        }
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
