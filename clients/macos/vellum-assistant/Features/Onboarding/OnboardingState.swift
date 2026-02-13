import SwiftUI

enum OnboardingVariant: String {
    case `default`
    case firstMeeting = "first_meeting"
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
    var speechGranted: Bool = false
    var accessibilityGranted: Bool = false
    var screenGranted: Bool = false
    var skipPermissionChecks: Bool = false
    var hasHatched: Bool = false
    var interviewCompleted: Bool = false
    var onboardingVariant: OnboardingVariant = .default

    // First-meeting-specific state
    var firstMeetingCrackProgress: CGFloat = 0.0
    var conversationCompleted: Bool = false
    var capabilitiesBriefingShown: Bool = false
    var observationCompleted: Bool = false
    var firstTaskCandidate: String? = nil
    var observationDurationMinutes: Int = 5
    var observationInsights: [String] = []

    var anyPermissionDenied: Bool {
        !speechGranted || !accessibilityGranted || !screenGranted
    }

    /// Continuous crack progress (0.0–1.0) derived from step and permission state.
    /// For the first meeting variant, uses a timer-driven stored property instead.
    var crackProgress: CGFloat {
        if onboardingVariant == .firstMeeting {
            return firstMeetingCrackProgress
        }
        switch currentStep {
        case 0: return hasHatched ? 0.15 : 0.0
        case 1: return 0.25
        case 2: return 0.35
        case 3: return speechGranted ? 0.55 : 0.40
        case 4: return accessibilityGranted ? 0.75 : 0.60
        case 5: return screenGranted ? 0.95 : 0.80
        case 6: return 1.0
        default: return 1.0
        }
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
            interviewCompleted = UserDefaults.standard.bool(forKey: "onboarding.interviewCompleted")
        }
        if let rawVariant = UserDefaults.standard.string(forKey: "onboarding.variant"),
           let variant = OnboardingVariant(rawValue: rawVariant) {
            onboardingVariant = variant
        }
        firstMeetingCrackProgress = CGFloat(UserDefaults.standard.double(forKey: "onboarding.firstMeetingCrackProgress"))
    }

    func advance() {
        withAnimation(.spring(duration: 0.6, bounce: 0.15)) {
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
        UserDefaults.standard.set(interviewCompleted, forKey: "onboarding.interviewCompleted")
        UserDefaults.standard.set(onboardingVariant.rawValue, forKey: "onboarding.variant")
        UserDefaults.standard.set(Double(firstMeetingCrackProgress), forKey: "onboarding.firstMeetingCrackProgress")
    }

    static func clearPersistedState() {
        for key in ["onboarding.step", "onboarding.name", "onboarding.key", "onboarding.hatched", "onboarding.interviewCompleted", "onboarding.variant", "onboarding.firstMeetingCrackProgress"] {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }
}
