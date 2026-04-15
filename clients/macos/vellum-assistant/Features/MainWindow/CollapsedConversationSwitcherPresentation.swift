import Foundation

struct CollapsedConversationSwitcherPresentation {
    let switchTargets: [ConversationModel]
    let activeConversationTitle: String?
    let totalRegularConversationCount: Int
    let hasReflectionConversations: Bool

    /// Switcher stays visible when there's at least one regular conversation OR
    /// at least one reflection conversation — the drawer it opens still surfaces
    /// the Reflections section, so hiding the entry point would orphan it.
    var showsSwitcher: Bool { totalRegularConversationCount > 0 || hasReflectionConversations }

    /// What to render inside the switcher badge. Normally a numeric count, but
    /// falls back to an icon when there are no regular conversations to count
    /// yet reflections exist — rendering a literal "0" in that case reads as
    /// a broken or dead affordance.
    enum Badge: Equatable {
        case count(String)
        case reflectionIcon
    }

    var badge: Badge {
        if totalRegularConversationCount == 0 && hasReflectionConversations {
            return .reflectionIcon
        }
        return .count(badgeText)
    }

    var badgeText: String {
        if totalRegularConversationCount > 99 { return "99+" }
        return "\(totalRegularConversationCount)"
    }

    var accessibilityLabel: String {
        if let title = activeConversationTitle {
            return "Switch conversations: \(title)"
        }
        return "Switch conversations"
    }

    var accessibilityValue: String {
        if totalRegularConversationCount > 0 {
            return "\(totalRegularConversationCount) conversations"
        }
        if hasReflectionConversations {
            return "Reflections available"
        }
        return ""
    }

    init(regularConversations: [ConversationModel], activeConversationId: UUID?, hasReflectionConversations: Bool = false) {
        self.totalRegularConversationCount = regularConversations.count
        self.hasReflectionConversations = hasReflectionConversations
        if let activeId = activeConversationId {
            self.switchTargets = regularConversations.filter { $0.id != activeId }
            self.activeConversationTitle = regularConversations.first(where: { $0.id == activeId })?.title
        } else {
            self.switchTargets = regularConversations
            self.activeConversationTitle = nil
        }
    }
}
