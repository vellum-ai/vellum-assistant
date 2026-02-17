#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct ContentView: View {
    @EnvironmentObject var clientProvider: ClientProvider

    var body: some View {
        TabView {
            ThreadListView(daemonClient: clientProvider.client)
                .tabItem {
                    Label("Chats", systemImage: "message")
                }

            SettingsView()
                .environmentObject(clientProvider)
                .tabItem {
                    Label("Settings", systemImage: "gear")
                }
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(ClientProvider(client: DaemonClient(config: .default)))
}
#endif
