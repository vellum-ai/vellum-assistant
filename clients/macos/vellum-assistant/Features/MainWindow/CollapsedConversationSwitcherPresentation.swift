import Foundation

struct CollapsedConversationSwitcherPresentation {
    let switchTargets: [ConversationModel]
    let activeConversationTitle: String?
    let totalRegularConversationCount: Int

    var showsSwitcher: Bool { totalRegularConversationCount > 0 }

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
        totalRegularConversationCount == 0 ? "" : "\(totalRegularConversationCount) conversations"
    }

    init(regularConversations: [ConversationModel], activeConversationId: UUID?) {
        self.totalRegularConversationCount = regularConversations.count
        if let activeId = activeConversationId {
            self.switchTargets = regularConversations.filter { $0.id != activeId }
            self.activeConversationTitle = regularConversations.first(where: { $0.id == activeId })?.title
        } else {
            self.switchTargets = regularConversations
            self.activeConversationTitle = nil
        }
    }
}
