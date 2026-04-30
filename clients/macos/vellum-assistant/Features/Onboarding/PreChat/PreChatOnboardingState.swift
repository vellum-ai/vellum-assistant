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

    /// Number of name suggestion pills to display.
    static let suggestionLimit = 6

    /// Names shown as quick-tap pills for this onboarding session. Sampled
    /// once at state creation from the full `PersonalityGroup.allNames` pool
    /// and held stable for the rest of the flow — picking a vibe does not
    /// refresh the suggestions, since names are no longer tied to vibes.
    let displayedAssistantNames: [String]

    // MARK: - Persistence Keys

    private static let prefix = "onboarding.prechat."
    private static let screenKey = "\(prefix)currentScreen"
    private static let toolsKey = "\(prefix)selectedTools"
    private static let tasksKey = "\(prefix)selectedTasks"
    private static let userNameKey = "\(prefix)userName"
    private static let assistantNameKey = "\(prefix)assistantName"
    private static let selectedGroupIDKey = "\(prefix)selectedGroupID"
    private static let displayedNamesKey = "\(prefix)displayedAssistantNames"

    private static let allKeys: [String] = [
        screenKey, toolsKey, tasksKey,
        userNameKey, assistantNameKey,
        selectedGroupIDKey, displayedNamesKey,
    ]

    // MARK: - Init (restore from UserDefaults)

    init() {
        self.assistantName = ""
        self.userName = ""

        let defaults = UserDefaults.standard

        // Restore the same suggestion sample across launches mid-flow; otherwise
        // sample a fresh `suggestionLimit` names from the full pool. Sampling
        // happens here (not lazily) so picking a vibe later does not perturb it.
        if let persisted = defaults.stringArray(forKey: Self.displayedNamesKey),
           persisted.count == Self.suggestionLimit {
            self.displayedAssistantNames = persisted
        } else {
            let sampled = Array(PersonalityGroup.allNames.shuffled().prefix(Self.suggestionLimit))
            self.displayedAssistantNames = sampled
            defaults.set(sampled, forKey: Self.displayedNamesKey)
        }

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
