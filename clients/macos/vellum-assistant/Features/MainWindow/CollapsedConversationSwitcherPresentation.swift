import Foundation

struct CollapsedConversationSwitcherPresentation {
    let switchTargets: [ConversationModel]
    let activeThreadTitle: String?
    let totalRegularThreadCount: Int

    var showsSwitcher: Bool { totalRegularThreadCount > 0 }

    var badgeText: String {
        if totalRegularThreadCount > 99 { return "99+" }
        return "\(totalRegularThreadCount)"
    }

    var accessibilityLabel: String {
        if let title = activeThreadTitle {
            return "Switch conversations: \(title)"
        }
        return "Switch conversations"
    }

    var accessibilityValue: String {
        totalRegularThreadCount == 0 ? "" : "\(totalRegularThreadCount) conversations"
    }

    init(regularConversations: [ConversationModel], activeConversationId: UUID?) {
        self.totalRegularThreadCount = regularConversations.count
        if let activeId = activeConversationId {
            self.switchTargets = regularConversations.filter { $0.id != activeId }
            self.activeThreadTitle = regularConversations.first(where: { $0.id == activeId })?.title
        } else {
            self.switchTargets = regularConversations
            self.activeThreadTitle = nil
        }
    }
}
