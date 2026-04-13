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
    var assistantName: String = RandomNameGenerator.generateInstanceName()
    var chosenKey: ActivationKey = .fn

    /// Whether the user explicitly skipped login during onboarding.
    var skippedAuth: Bool = false

    /// Whether step 2 (API key entry) was skipped during this onboarding run.
    /// Set when an authenticated user advances directly from step 1 to step 3.
    var skippedAPIKeyEntry: Bool = false

    /// The hosting mode selected in onboarding step 1.
    var selectedHostingMode: HostingMode = .vellumCloud

    enum HostingMode: String {
        case vellumCloud = "vellum-cloud"
        case local = "local"
        case docker = "docker"
        case oldLocal = "oldLocal"
        case gcp = "gcp"
        case aws = "aws"
        case customHardware = "customHardware"

        var displayName: String {
            switch self {
            case .vellumCloud: return "Vellum Cloud"
            case .local: return "Local"
            case .docker: return "Local (Container)"
            case .oldLocal: return "Old Local"
            case .gcp: return "GCP"
            case .aws: return "AWS"
            case .customHardware: return "Custom"
            }
        }

        var subtitle: String {
            switch self {
            case .vellumCloud: return "Always on, 24/7, even when your Mac is asleep. Runs on Vellum's secure infrastructure."
            case .local: return "Your machine, your data. Nothing leaves your Mac."
            case .docker: return "Same privacy as local, but sandboxed using Docker."
            case .oldLocal: return "Legacy local mode without Docker."
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
    /// When true, the onboarding flow was launched from the developer tab's
    /// "Hatch New Assistant" button. This prevents auto-completing when the user
    /// already has a managed assistant, forcing the hosting selector to appear so
    /// they can choose where the new assistant runs.
    var isRehatch: Bool = false

    var isHatching: Bool = false
    var isManagedHatch: Bool = false
    var hasExistingManagedAssistant: Bool = false
    var hatchLogLines: [String] = []
    var hatchCompleted: Bool = false
    var hatchFailed: Bool = false

    /// Progress bar state for the hatching flow.
    var hatchProgressTarget: Double = 0.0    // 0..1, set by progress events
    var hatchProgressDisplay: Double = 0.0   // 0..1, what the bar renders
    var hatchStepLabel: String?              // nil = don't show bar yet
    var hatchTotalSteps: Int = 1
    var hatchCurrentStep: Int = 0

    /// Pre-chat onboarding context collected after hatching when the
    /// `onboarding-pre-chat` feature flag is enabled. Threaded through
    /// AppDelegate → ConversationManager → ChatViewModel so the first
    /// message POST includes it for assistant personalization.
    var preChatContext: PreChatOnboardingContext?

    /// Avatar traits generated during the hatching animation. Stored here
    /// (rather than as @State in HatchingStepView) so they survive view
    /// disappearance and are available to the post-hatch sync logic.
    var hatchAvatarBodyShape: AvatarBodyShape?
    var hatchAvatarEyeStyle: AvatarEyeStyle?
    var hatchAvatarColor: AvatarColor?

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
            assistantName = UserDefaults.standard.string(forKey: "onboarding.name") ?? RandomNameGenerator.generateInstanceName()
            if let raw = UserDefaults.standard.string(forKey: "onboarding.key"),
               let key = ActivationKey(rawValue: raw) {
                chosenKey = key
            }
            hasHatched = UserDefaults.standard.bool(forKey: "onboarding.hatched")
            cloudProvider = UserDefaults.standard.string(forKey: "onboarding.cloudProvider") ?? "local"
            skippedAPIKeyEntry = UserDefaults.standard.bool(forKey: "onboarding.skippedAPIKeyEntry")
            if let rawHosting = UserDefaults.standard.string(forKey: "onboarding.selectedHostingMode"),
               let mode = HostingMode(rawValue: rawHosting) {
                selectedHostingMode = mode
            }
        }
        // Clamp restored step to the valid range.
        let maxStep = 3
        if currentStep > maxStep {
            currentStep = maxStep
        }

        // Opt in to usage data and diagnostics by default for new users.
        // Also check legacy keys so we don't override an existing opt-out from
        // users who haven't yet been migrated by syncPrivacyConfig().
        if UserDefaults.standard.object(forKey: "collectUsageData") == nil
            && UserDefaults.standard.object(forKey: "collectUsageDataEnabled") == nil {
            UserDefaults.standard.set(true, forKey: "collectUsageData")
        }
        if UserDefaults.standard.object(forKey: "sendDiagnostics") == nil
            && UserDefaults.standard.object(forKey: "sendPerformanceReports") == nil {
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
        UserDefaults.standard.set(cloudProvider, forKey: "onboarding.cloudProvider")
        UserDefaults.standard.set(Self.currentFlowVersion, forKey: "onboarding.flowVersion")
        UserDefaults.standard.set(skippedAPIKeyEntry, forKey: "onboarding.skippedAPIKeyEntry")
        UserDefaults.standard.set(selectedHostingMode.rawValue, forKey: "onboarding.selectedHostingMode")
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
        hatchAvatarBodyShape = nil
        hatchAvatarEyeStyle = nil
        hatchAvatarColor = nil
        hatchProgressTarget = 0.0
        hatchProgressDisplay = 0.0
        hatchStepLabel = nil
        hatchTotalSteps = 1
        hatchCurrentStep = 0
        hasHatched = false
        skippedAuth = false
        skippedAPIKeyEntry = false

        // Reset ToS acceptance so the user must re-accept on re-hatch
        UserDefaults.standard.set(false, forKey: "tosAccepted")

        // Clear API key for whichever provider was selected during onboarding
        let providerToDelete = selectedProvider
        if selectedProvider != "anthropic" {
            APIKeyManager.deleteKey(for: selectedProvider)
        }
        APIKeyManager.deleteKey(for: "anthropic")
        Task {
            if providerToDelete != "anthropic" {
                await APIKeyManager.deleteKey(for: providerToDelete)
            }
            await APIKeyManager.deleteKey(for: "anthropic")
        }

        selectedProvider = "anthropic"
        selectedModel = "claude-opus-4-6"

        // Reset hosting selection and cloud credentials
        selectedHostingMode = .vellumCloud
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
        for key in ["onboarding.step", "onboarding.name", "onboarding.key", "onboarding.hatched", "onboarding.interviewCompleted", "onboarding.flowVersion", "onboarding.cloudProvider", "onboarding.skippedAPIKeyEntry", "onboarding.selectedHostingMode", "onboarding.variant", "onboarding.firstMeetingCrackProgress"] {
            UserDefaults.standard.removeObject(forKey: key)
        }
    }
}
