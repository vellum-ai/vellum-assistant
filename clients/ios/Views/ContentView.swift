import SwiftUI
import VellumAssistantShared

struct ContentView: View {
    @EnvironmentObject var daemonClient: DaemonClient

    var body: some View {
        TabView {
            NavigationView {
                ChatTabView(daemonClient: daemonClient)
            }
            .tabItem {
                Label("Chat", systemImage: "message")
            }

            Text("Settings")
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
