import SwiftUI

enum OrbMood {
    case egg
    case dormant
    case breathing
    case listening
    case celebrating
}

enum ActivationKey: String {
    case fn
    case ctrl

    var displayName: String {
        switch self {
        case .fn: return "fn"
        case .ctrl: return "ctrl"
        }
    }
}

@Observable
@MainActor
final class OnboardingState {
    var currentStep: Int = 0
    var assistantName: String = ""
    var chosenKey: ActivationKey = .fn
    var orbMood: OrbMood = .dormant
    var speechGranted: Bool = false
    var accessibilityGranted: Bool = false
    var screenGranted: Bool = false
    var skipPermissionChecks: Bool = false
    var hasHatched: Bool = false
    var hatchTrigger: (() -> Void)?

    var anyPermissionDenied: Bool {
        !speechGranted || !accessibilityGranted || !screenGranted
    }

    func advance() {
        withAnimation(.easeOut(duration: 0.8)) {
            currentStep += 1
        }
    }
}
