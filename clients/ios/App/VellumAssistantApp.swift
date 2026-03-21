#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

@main
struct VellumAssistantApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @AppStorage("onboarding_completed") private var onboardingCompleted = false
    @AppStorage("appearance_mode") private var appearanceMode: String = "system"

    var preferredScheme: ColorScheme? {
        switch appearanceMode {
        case "light": return .light
        case "dark": return .dark
        default: return nil  // system default
        }
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if onboardingCompleted {
                    ContentView(
                        authManager: appDelegate.authManager,
                        ambientAgent: appDelegate.ambientAgentManager,
                        daemonClient: appDelegate.clientProvider.client,
                        eventStreamClient: appDelegate.clientProvider.eventStreamClient
                    )
                    .environmentObject(appDelegate.clientProvider)
                } else {
                    OnboardingView(isCompleted: $onboardingCompleted, authManager: appDelegate.authManager)
                        .environmentObject(appDelegate.clientProvider)
                }
            }
            .preferredColorScheme(preferredScheme)
            .onOpenURL { url in
                handleDeepLink(url)
            }
        }
    }

    /// Handle `vellum://send?message=...` deep links by buffering the message
    /// in `DeepLinkManager` for the active `ChatViewModel` to consume.
    private func handleDeepLink(_ url: URL) {
        guard url.scheme == "vellum", url.host == "send" else { return }
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let messageItem = components.queryItems?.first(where: { $0.name == "message" }),
              let message = messageItem.value, !message.isEmpty else { return }
        DeepLinkManager.pendingMessage = message
    }
}
#else
// Stub entry point so the iOS executable target links on macOS
// (all real code is UIKit-only and compiled out on this platform).
@main
struct VellumAssistantApp {
    static func main() {}
}
#endif
