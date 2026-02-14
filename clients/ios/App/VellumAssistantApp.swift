import SwiftUI
import VellumAssistantShared

@main
struct VellumAssistantApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @AppStorage("onboarding_completed") private var onboardingCompleted = false

    var body: some Scene {
        WindowGroup {
            if onboardingCompleted {
                ContentView()
                    .environmentObject(appDelegate.daemonClient)
            } else {
                OnboardingView(isCompleted: $onboardingCompleted)
            }
        }
    }
}
