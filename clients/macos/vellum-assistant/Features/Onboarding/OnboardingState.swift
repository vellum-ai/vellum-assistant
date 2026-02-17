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
    /// Bump this version whenever the default-flow step order changes so that
    /// persisted step indices from a previous layout are not consumed as-is.
    private static let currentFlowVersion = 4

    var currentStep: Int = 0
    var assistantName: String = "Velly"
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
        case 1: return 0.20
        case 2: return 0.30
        case 3: return 0.40
        case 4: return speechGranted ? 0.55 : 0.45
        case 5: return accessibilityGranted ? 0.75 : 0.60
        case 6: return screenGranted ? 0.95 : 0.80
        case 7: return 1.0
        default: return 1.0
        }
    }

    /// Restore onboarding progress from a previous session (e.g. after macOS
    /// kills the app when toggling screen-recording permission).
    init() {
        let saved = UserDefaults.standard.integer(forKey: "onboarding.step")
        let storedFlowVersion = UserDefaults.standard.integer(forKey: "onboarding.flowVersion")

        if saved > 0 {
            // If the flow layout changed since the step was persisted, the
            // stored index no longer maps to the same stage. Reset to the
            // beginning so the user doesn't land on the wrong step.
            if storedFlowVersion != Self.currentFlowVersion {
                currentStep = 0
                UserDefaults.standard.set(0, forKey: "onboarding.step")
                UserDefaults.standard.set(Self.currentFlowVersion, forKey: "onboarding.flowVersion")
            } else {
                currentStep = saved
            }
            assistantName = UserDefaults.standard.string(forKey: "onboarding.name") ?? "Velly"
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

        // Clamp restored step to the variant's maximum to prevent out-of-range
        // rendering (e.g. a step saved from the 8-step default flow would be
        // invalid for the 5-step first-meeting flow).
        // Default onboarding now exits immediately after the first post-hatch
        // conversation entry point (step 2). Prevent stale persisted indices
        // from reopening legacy permission-request steps.
        let maxStep = onboardingVariant == .firstMeeting ? 4 : 2
        if currentStep > maxStep {
            currentStep = maxStep
        }
        // Skip naming step (step 1) if restored to it
        if onboardingVariant == .default && currentStep == 1 {
            currentStep = 2
        }
    }

    func advance() {
        withAnimation(.spring(duration: 0.6, bounce: 0.15)) {
            currentStep += 1
            // Skip naming step (step 1) — name defaults to "Velly"
            // Skip everything after API key (steps 3+) — go straight to chat
            if currentStep == 1 {
                currentStep = 2
            }
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
        UserDefaults.standard.set(Self.currentFlowVersion, forKey: "onboarding.flowVersion")
    }

    static func clearPersistedState() {
        for key in ["onboarding.step", "onboarding.name", "onboarding.key", "onboarding.hatched", "onboarding.interviewCompleted", "onboarding.variant", "onboarding.firstMeetingCrackProgress", "onboarding.flowVersion"] {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }
}
