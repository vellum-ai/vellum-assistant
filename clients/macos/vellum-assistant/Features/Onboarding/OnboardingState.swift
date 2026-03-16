import VellumAssistantShared
import SwiftUI

enum OnboardingVariant: String {
    case `default`
    case firstMeeting = "first_meeting"
}

enum ActivationKey: String, CaseIterable {
    case fn
    case ctrl
    case fnShift = "fn_shift"
    case none

    var displayName: String {
        switch self {
        case .fn: return "fn"
        case .ctrl: return "ctrl"
        case .fnShift: return "fn + shift"
        case .none: return "Off"
        }
    }
}

@Observable
@MainActor
final class OnboardingState {
    /// Bump this version whenever the default-flow step order changes so that
    /// persisted step indices from a previous layout are not consumed as-is.
    private static let currentFlowVersion = 12

    var currentStep: Int = 0
    var assistantName: String = "Velly"
    var chosenKey: ActivationKey = .fn
    var speechGranted: Bool = false
    var accessibilityGranted: Bool = false
    var screenGranted: Bool = false
    var skipPermissionChecks: Bool = false

    /// Whether the user explicitly skipped login during onboarding.
    var skippedAuth: Bool = false

    /// The hosting mode selected in onboarding step 1.
    var selectedHostingMode: HostingMode = .local

    enum HostingMode: String {
        case vellumCloud = "vellum-cloud"
        case local = "local"
        case docker = "docker"
        case gcp = "gcp"
        case aws = "aws"
        case customHardware = "customHardware"

        var displayName: String {
            switch self {
            case .vellumCloud: return "Vellum Cloud"
            case .local: return "Local"
            case .docker: return "Docker"
            case .gcp: return "GCP"
            case .aws: return "AWS"
            case .customHardware: return "Custom"
            }
        }

        var subtitle: String {
            switch self {
            case .vellumCloud: return "Hosted and managed by Vellum"
            case .local: return "Run on your machine"
            case .docker: return "Run in a Docker container"
            case .gcp: return "Host on your GCP account"
            case .aws: return "Host on your AWS account"
            case .customHardware: return "Run on your own hardware"
            }
        }
    }
    var hasHatched: Bool = false
    var interviewCompleted: Bool = false
    var cloudProvider: String = "local"
    var onboardingVariant: OnboardingVariant = .default

    /// When false, step changes are not written to UserDefaults (used by auth gate).
    var shouldPersist: Bool = true

    // Cloud credentials held in memory during onboarding (never written to .vellum)
    var gcpProjectId: String = ""
    var gcpZone: String = "us-central1-a"
    var gcpServiceAccountKey: String = ""
    var awsRoleArn: String = ""
    var sshHost: String = ""
    var sshUser: String = ""
    var sshPrivateKey: String = ""
    var customQRCodeImageData: Data = Data()
    var selectedModel: String = "claude-opus-4-6"
    var isHatching: Bool = false
    var isManagedHatch: Bool = false
    var hasExistingManagedAssistant: Bool = false
    var hatchLogLines: [String] = []
    var hatchCompleted: Bool = false
    var hatchFailed: Bool = false

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
        case 2: return 0.25
        case 3: return 0.30
        case 4: return 0.60
        case 5: return speechGranted ? 0.70 : 0.65
        case 6: return accessibilityGranted ? 0.80 : 0.70
        case 7: return screenGranted ? 0.95 : 0.85
        case 8: return 1.0
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
            cloudProvider = UserDefaults.standard.string(forKey: "onboarding.cloudProvider") ?? "local"
        }
        if let rawVariant = UserDefaults.standard.string(forKey: "onboarding.variant"),
           let variant = OnboardingVariant(rawValue: rawVariant) {
            onboardingVariant = variant
        }
        firstMeetingCrackProgress = CGFloat(UserDefaults.standard.double(forKey: "onboarding.firstMeetingCrackProgress"))

        // Clamp restored step to the variant's maximum to prevent out-of-range
        // rendering (e.g. a step saved from the 8-step default flow would be
        // invalid for the 5-step first-meeting flow).
        let isManagedSignIn = MacOSClientFeatureFlagManager.shared.isEnabled("managed_sign_in_enabled")
        let maxStep: Int
        if isManagedSignIn {
            maxStep = 2
        } else if onboardingVariant == .firstMeeting {
            maxStep = 4
        } else {
            maxStep = 2
        }
        if currentStep > maxStep {
            currentStep = maxStep
        }

        // Opt in to usage data and diagnostics by default for new users.
        if UserDefaults.standard.object(forKey: "collectUsageData") == nil {
            UserDefaults.standard.set(true, forKey: "collectUsageData")
        }
        if UserDefaults.standard.object(forKey: "sendDiagnostics") == nil {
            UserDefaults.standard.set(true, forKey: "sendDiagnostics")
        }
    }

    func advance(by steps: Int = 1) {
        withAnimation(.spring(duration: 0.6, bounce: 0.15)) {
            currentStep += steps
        }
        if shouldPersist { persist() }
    }

    /// Persist progress so we can resume after a forced restart.
    private func persist() {
        UserDefaults.standard.set(currentStep, forKey: "onboarding.step")
        UserDefaults.standard.set(assistantName, forKey: "onboarding.name")
        UserDefaults.standard.set(chosenKey.rawValue, forKey: "onboarding.key")
        UserDefaults.standard.set(hasHatched, forKey: "onboarding.hatched")
        UserDefaults.standard.set(interviewCompleted, forKey: "onboarding.interviewCompleted")
        UserDefaults.standard.set(cloudProvider, forKey: "onboarding.cloudProvider")
        UserDefaults.standard.set(onboardingVariant.rawValue, forKey: "onboarding.variant")
        UserDefaults.standard.set(Double(firstMeetingCrackProgress), forKey: "onboarding.firstMeetingCrackProgress")
        UserDefaults.standard.set(Self.currentFlowVersion, forKey: "onboarding.flowVersion")
    }

    /// Resets all hatch-related and credential state for a clean retry,
    /// including persisted UserDefaults keys.
    func resetForRetry() {
        // Reset hatch flags
        isHatching = false
        isManagedHatch = false
        hasExistingManagedAssistant = false
        hatchFailed = false
        hatchCompleted = false
        hatchLogLines = []
        hasHatched = false
        skippedAuth = false

        // Clear stored API key so the user starts fresh
        APIKeyManager.deleteKey(for: "anthropic")

        // Reset cloud credentials (in-memory only; not persisted)
        cloudProvider = "local"
        gcpProjectId = ""
        gcpZone = "us-central1-a"
        gcpServiceAccountKey = ""
        awsRoleArn = ""
        sshHost = ""
        sshUser = ""
        sshPrivateKey = ""
        customQRCodeImageData = Data()

        // Return to welcome screen and persist the reset
        currentStep = 0
        if shouldPersist { persist() }
    }

    static func clearPersistedState() {
        for key in ["onboarding.step", "onboarding.name", "onboarding.key", "onboarding.hatched", "onboarding.interviewCompleted", "onboarding.variant", "onboarding.firstMeetingCrackProgress", "onboarding.flowVersion", "onboarding.cloudProvider"] {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }
}
