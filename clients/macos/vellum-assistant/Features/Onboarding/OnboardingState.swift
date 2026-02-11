import SwiftUI

enum OrbMood {
    case egg
    case dormant
    case breathing
    case listening
    case celebrating
}

enum ActivationKey: String, CaseIterable {
    case fn
    case ctrl
    case none

    var displayName: String {
        switch self {
        case .fn: return "fn"
        case .ctrl: return "ctrl"
        case .none: return "Off"
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

    /// Restore onboarding progress from a previous session (e.g. after macOS
    /// kills the app when toggling screen-recording permission).
    init() {
        let saved = UserDefaults.standard.integer(forKey: "onboarding.step")
        if saved > 0 {
            currentStep = saved
            assistantName = UserDefaults.standard.string(forKey: "onboarding.name") ?? ""
            if let raw = UserDefaults.standard.string(forKey: "onboarding.key"),
               let key = ActivationKey(rawValue: raw) {
                chosenKey = key
            }
            hasHatched = UserDefaults.standard.bool(forKey: "onboarding.hatched")
        }
    }

    func advance() {
        withAnimation(.easeOut(duration: 0.8)) {
            currentStep += 1
        }
        persist()
    }

    /// Persist progress so we can resume after a forced restart.
    private func persist() {
        UserDefaults.standard.set(currentStep, forKey: "onboarding.step")
        UserDefaults.standard.set(assistantName, forKey: "onboarding.name")
        UserDefaults.standard.set(chosenKey.rawValue, forKey: "onboarding.key")
        UserDefaults.standard.set(hasHatched, forKey: "onboarding.hatched")
    }

    static func clearPersistedState() {
        for key in ["onboarding.step", "onboarding.name", "onboarding.key", "onboarding.hatched"] {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }
}
