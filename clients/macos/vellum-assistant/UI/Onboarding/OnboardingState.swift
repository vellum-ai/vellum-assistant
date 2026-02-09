import SwiftUI

enum OrbMood {
    case breathing
    case listening
    case celebrating
}

enum ActivationKey: String {
    case fn
    case globe
    case ctrl
}

@Observable
@MainActor
final class OnboardingState {
    var currentStep: Int = 0
    var assistantName: String = ""
    var chosenKey: ActivationKey = .fn
    var orbMood: OrbMood = .breathing
    var micGranted: Bool = false
    var screenGranted: Bool = false
    var skipPermissionChecks: Bool = false

    func advance() {
        withAnimation(.easeOut(duration: 0.8)) {
            currentStep += 1
        }
    }
}
