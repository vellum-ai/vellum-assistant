import VellumAssistantShared
import SwiftUI

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
    private static let currentFlowVersion = 13

    var currentStep: Int = 0
    var assistantName: String = "Velly"
    var chosenKey: ActivationKey = .fn

    /// Whether the user explicitly skipped login during onboarding.
    var skippedAuth: Bool = false

    /// Whether step 2 (API key entry) was skipped during this onboarding run.
    /// Set when an authenticated user advances directly from step 1 to step 3.
    var skippedAPIKeyEntry: Bool = false

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
            case .docker: return "Local (Container)"
            case .gcp: return "GCP"
            case .aws: return "AWS"
            case .customHardware: return "Custom"
            }
        }

        var subtitle: String {
            switch self {
            case .vellumCloud: return "Ready out of the box. Runs entirely on Vellum's secure infrastructure."
            case .local: return "Your machine, your data. Nothing leaves your Mac."
            case .docker: return "Same privacy as local, but sandboxed using Docker."
            case .gcp: return "Host on your GCP account"
            case .aws: return "Host on your AWS account"
            case .customHardware: return "Run on your own hardware"
            }
        }
    }
    var hasHatched: Bool = false
    var cloudProvider: String = "local"

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
    var selectedProvider: String = "anthropic"
    var isHatching: Bool = false
    var isManagedHatch: Bool = false
    var hasExistingManagedAssistant: Bool = false
    var hatchLogLines: [String] = []
    var hatchCompleted: Bool = false
    var hatchFailed: Bool = false

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
            cloudProvider = UserDefaults.standard.string(forKey: "onboarding.cloudProvider") ?? "local"
            skippedAPIKeyEntry = UserDefaults.standard.bool(forKey: "onboarding.skippedAPIKeyEntry")
        }
        // Clamp restored step to the valid range.
        let maxStep = 3
        if currentStep > maxStep {
            currentStep = maxStep
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
        UserDefaults.standard.set(cloudProvider, forKey: "onboarding.cloudProvider")
        UserDefaults.standard.set(Self.currentFlowVersion, forKey: "onboarding.flowVersion")
        UserDefaults.standard.set(skippedAPIKeyEntry, forKey: "onboarding.skippedAPIKeyEntry")
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
        skippedAPIKeyEntry = false

        // Reset ToS acceptance so the user must re-accept on re-hatch
        UserDefaults.standard.set(false, forKey: "tosAccepted")

        // Clear stored API key so the user starts fresh
        APIKeyManager.deleteKey(for: "anthropic")

        selectedProvider = "anthropic"

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
        for key in ["onboarding.step", "onboarding.name", "onboarding.key", "onboarding.hatched", "onboarding.interviewCompleted", "onboarding.flowVersion", "onboarding.cloudProvider", "onboarding.skippedAPIKeyEntry", "onboarding.variant", "onboarding.firstMeetingCrackProgress"] {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }
}
