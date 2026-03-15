import Foundation

enum OnboardingManagedContinuationAction: Equatable {
    case startLogin
    case bootstrap
}

func onboardingPrimaryButtonTitle(isAuthenticated: Bool, hasAssistant: Bool = true) -> String {
    if !isAuthenticated {
        return "Sign in"
    }
    return hasAssistant ? "Talk to your assistant" : "Hatch your assistant"
}

func onboardingManagedContinuationAction(isAuthenticated: Bool) -> OnboardingManagedContinuationAction {
    if isAuthenticated {
        return .bootstrap
    }
    return .startLogin
}
