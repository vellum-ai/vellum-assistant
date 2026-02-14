import SwiftUI
import VellumAssistantShared

@main
struct VellumAssistantApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(appDelegate.daemonClient)
        }
    }
}
