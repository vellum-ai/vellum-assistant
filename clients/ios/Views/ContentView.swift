#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct ContentView: View {
    @EnvironmentObject var daemonClient: DaemonClient

    var body: some View {
        TabView {
            NavigationStack {
                ChatTabView(daemonClient: daemonClient)
            }
            .tabItem {
                Label("Chat", systemImage: "message")
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
