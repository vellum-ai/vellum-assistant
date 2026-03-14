import Foundation

enum OnboardingManagedContinuationAction: Equatable {
    case startLogin
    case bootstrap
}

func onboardingPrimaryButtonTitle(isAuthenticated: Bool) -> String {
    isAuthenticated ? "Talk to your assistant" : "Sign in"
}

func onboardingManagedContinuationAction(isAuthenticated: Bool) -> OnboardingManagedContinuationAction {
    if isAuthenticated {
        return .bootstrap
    }
    return .startLogin
}
