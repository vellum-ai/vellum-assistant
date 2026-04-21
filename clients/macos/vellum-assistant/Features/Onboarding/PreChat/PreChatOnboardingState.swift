import SwiftUI
import VellumAssistantShared

/// Aggregated state for the pre-chat onboarding flow.
///
/// Persists all selections to UserDefaults with an `onboarding.prechat.` prefix
/// so the flow survives app crashes mid-flow. Cleared on completion.
@Observable
@MainActor
final class PreChatOnboardingState {
    /// Bump when the screen order changes so stale persisted indices are reset.
    private static let currentFlowVersion = 2

    var currentScreen: Int = 0 // 0 = tools, 1 = tasks/tone, 2 = names
    var selectedTools: Set<String> = []
    var selectedTasks: Set<String> = []
    var toneValue: Double = 0.5 // 0 = casual, 0.5 = balanced, 1 = professional
    var userName: String
    var assistantName: String
    var skippedAll: Bool = false

    /// Random subset of `NameExchangeView.assistantNamePool` displayed as
    /// quick-tap suggestion pills. Sampled once per state instance so the pills
    /// remain stable across re-renders and back-navigation within a session.
    /// Not persisted to UserDefaults — a fresh sample is drawn on each run.
    let displayedAssistantNames: [String]

    var toneLabel: String {
        if toneValue < 0.25 { return "casual" }
        if toneValue > 0.75 { return "professional" }
        return "balanced"
    }

    // MARK: - Persistence Keys

    private static let prefix = "onboarding.prechat."
    private static let screenKey = "\(prefix)currentScreen"
    private static let toolsKey = "\(prefix)selectedTools"
    private static let tasksKey = "\(prefix)selectedTasks"
    private static let toneKey = "\(prefix)toneValue"
    private static let userNameKey = "\(prefix)userName"
    private static let assistantNameKey = "\(prefix)assistantName"
    private static let flowVersionKey = "\(prefix)flowVersion"

    private static let allKeys: [String] = [
        screenKey, toolsKey, tasksKey, toneKey,
        userNameKey, assistantNameKey, flowVersionKey,
    ]

    // MARK: - Init (restore from UserDefaults)

    init() {
        let sampled = NameExchangeView.sampleAssistantNames()
        self.displayedAssistantNames = sampled
        self.assistantName = sampled.first ?? "Pax"
        self.userName = ""

        let defaults = UserDefaults.standard
        let storedVersion = defaults.integer(forKey: Self.flowVersionKey)

        guard storedVersion == Self.currentFlowVersion else {
            // No persisted state or version mismatch — start fresh.
            // Pre-fill userName from system account.
            userName = NameExchangeView.defaultUserName()
            return
        }

        currentScreen = min(defaults.integer(forKey: Self.screenKey), 2)

        if let tools = defaults.stringArray(forKey: Self.toolsKey) {
            selectedTools = Set(tools)
        }
        if let tasks = defaults.stringArray(forKey: Self.tasksKey) {
            selectedTasks = Set(tasks)
        }

        toneValue = defaults.double(forKey: Self.toneKey)

        if let name = defaults.string(forKey: Self.userNameKey) {
            userName = name
        } else {
            userName = NameExchangeView.defaultUserName()
        }

        if let name = defaults.string(forKey: Self.assistantNameKey), !name.isEmpty,
           !name.hasPrefix("vellum-") {
            assistantName = name
        }
    }

    // MARK: - Persist

    func persist() {
        let defaults = UserDefaults.standard
        defaults.set(Self.currentFlowVersion, forKey: Self.flowVersionKey)
        defaults.set(currentScreen, forKey: Self.screenKey)
        defaults.set(Array(selectedTools), forKey: Self.toolsKey)
        defaults.set(Array(selectedTasks), forKey: Self.tasksKey)
        defaults.set(toneValue, forKey: Self.toneKey)
        defaults.set(userName, forKey: Self.userNameKey)
        defaults.set(assistantName, forKey: Self.assistantNameKey)
    }

    // MARK: - Clear

    static func clearPersistedState() {
        let defaults = UserDefaults.standard
        for key in allKeys {
            defaults.removeObject(forKey: key)
        }
    }
}
