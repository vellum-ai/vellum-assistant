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
                    ContentView()
                        .environmentObject(appDelegate.clientProvider)
                } else {
                    OnboardingView(isCompleted: $onboardingCompleted)
                }
            }
            .preferredColorScheme(preferredScheme)
        }
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
