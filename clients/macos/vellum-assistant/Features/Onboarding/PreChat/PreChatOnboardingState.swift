import SwiftUI
import VellumAssistantShared

/// Aggregated state for the pre-chat onboarding flow.
///
/// Persists all selections to UserDefaults with an `onboarding.prechat.` prefix
/// so the flow survives app crashes mid-flow. Cleared on completion.
@Observable
@MainActor
final class PreChatOnboardingState {
    var currentScreen: Int = 0 // 0 = tools, 1 = tasks/tone, 2 = names
    var selectedTools: Set<String> = []
    var selectedTasks: Set<String> = []
    var userName: String
    var assistantName: String
    var skippedAll: Bool = false

    /// The currently selected personality group ID, or `nil` for no selection.
    var selectedGroupID: String?

    /// A representative sample shown when no personality group is selected.
    static let tasterNames = ["Penn", "Sage", "Wren", "Milo", "Nova", "Ember", "Luna", "Iris"]

    /// Names to show as quick-tap pills. When a group is selected, shows only
    /// that group's names. Otherwise shows a curated taster sample.
    var displayedAssistantNames: [String] {
        guard let selectedID = selectedGroupID,
              let group = PersonalityGroup.allGroups.first(where: { $0.id == selectedID }) else {
            return Self.tasterNames
        }
        return group.names
    }

    // MARK: - Persistence Keys

    private static let prefix = "onboarding.prechat."
    private static let screenKey = "\(prefix)currentScreen"
    private static let toolsKey = "\(prefix)selectedTools"
    private static let tasksKey = "\(prefix)selectedTasks"
    private static let userNameKey = "\(prefix)userName"
    private static let assistantNameKey = "\(prefix)assistantName"
    private static let selectedGroupIDKey = "\(prefix)selectedGroupID"

    private static let allKeys: [String] = [
        screenKey, toolsKey, tasksKey,
        userNameKey, assistantNameKey,
        selectedGroupIDKey,
    ]

    // MARK: - Init (restore from UserDefaults)

    init() {
        self.assistantName = ""
        self.userName = ""

        let defaults = UserDefaults.standard

        currentScreen = min(defaults.integer(forKey: Self.screenKey), 2)

        if let tools = defaults.stringArray(forKey: Self.toolsKey) {
            selectedTools = Set(tools)
        }
        if let tasks = defaults.stringArray(forKey: Self.tasksKey) {
            selectedTasks = Set(tasks)
        }

        if let name = defaults.string(forKey: Self.userNameKey) {
            userName = name
        } else {
            userName = NameExchangeView.defaultUserName()
        }

        if let name = defaults.string(forKey: Self.assistantNameKey), !name.isEmpty,
           !name.hasPrefix("vellum-") {
            assistantName = name
        }

        selectedGroupID = defaults.string(forKey: Self.selectedGroupIDKey)
    }

    // MARK: - Persist

    func persist() {
        let defaults = UserDefaults.standard
        defaults.set(currentScreen, forKey: Self.screenKey)
        defaults.set(Array(selectedTools), forKey: Self.toolsKey)
        defaults.set(Array(selectedTasks), forKey: Self.tasksKey)
        defaults.set(userName, forKey: Self.userNameKey)
        defaults.set(assistantName, forKey: Self.assistantNameKey)
        defaults.set(selectedGroupID, forKey: Self.selectedGroupIDKey)
    }

    // MARK: - Clear

    static func clearPersistedState() {
        let defaults = UserDefaults.standard
        for key in allKeys {
            defaults.removeObject(forKey: key)
        }
    }
}
