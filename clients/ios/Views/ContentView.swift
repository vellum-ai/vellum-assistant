#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct ContentView: View {
    @EnvironmentObject var clientProvider: ClientProvider

    var body: some View {
        TabView {
            HomeBaseView()
                .environmentObject(clientProvider)
                .id(ObjectIdentifier(clientProvider.client as AnyObject))
                .tabItem {
                    Label("Home", systemImage: "house")
                }

            ThreadListView(daemonClient: clientProvider.client)
                // Force @StateObject teardown + recreation when the client changes.
                // Without this, IOSThreadStore keeps its original (now-disconnected)
                // client reference after a mode switch in Settings.
                .id(ObjectIdentifier(clientProvider.client as AnyObject))
                .tabItem {
                    Label("Chats", systemImage: "message")
                }

            IdentityView()
                .environmentObject(clientProvider)
                .id(ObjectIdentifier(clientProvider.client as AnyObject))
                .tabItem {
                    Label("Identity", systemImage: "person.text.rectangle")
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
