#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct ContentView: View {
    @EnvironmentObject var daemonClient: DaemonClient

    var body: some View {
        TabView {
            ThreadListView(daemonClient: daemonClient)
                .tabItem {
                    Label("Chats", systemImage: "message")
                }

            SettingsView()
                .tabItem {
                    Label("Settings", systemImage: "gear")
                }
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(DaemonClient(config: .default))
}
#endif
