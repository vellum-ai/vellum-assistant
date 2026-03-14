import Foundation

enum OnboardingManagedContinuationAction: Equatable {
    case startLogin
    case bootstrap
}

func onboardingPrimaryButtonTitle(isAuthenticated: Bool, managedSignInEnabled: Bool) -> String {
    if isAuthenticated { return "Talk to your assistant" }
    return managedSignInEnabled ? "Sign in" : "Coming Soon"
}

func onboardingManagedContinuationAction(isAuthenticated: Bool) -> OnboardingManagedContinuationAction {
    if isAuthenticated {
        return .bootstrap
    }
    return .startLogin
}
