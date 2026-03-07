import Foundation

struct CollapsedThreadSwitcherPresentation {
    let switchTargets: [ThreadModel]
    let activeThreadTitle: String?
    let totalRegularThreadCount: Int

    var showsSwitcher: Bool { totalRegularThreadCount > 0 }

    var badgeText: String {
        if totalRegularThreadCount > 99 { return "99+" }
        return "\(totalRegularThreadCount)"
    }

    var accessibilityLabel: String {
        if let title = activeThreadTitle {
            return "Switch threads: \(title)"
        }
        return "Switch threads"
    }

    var accessibilityValue: String {
        totalRegularThreadCount == 0 ? "" : "\(totalRegularThreadCount) threads"
    }

    init(regularThreads: [ThreadModel], activeThreadId: UUID?) {
        self.totalRegularThreadCount = regularThreads.count
        if let activeId = activeThreadId {
            self.switchTargets = regularThreads.filter { $0.id != activeId }
            self.activeThreadTitle = regularThreads.first(where: { $0.id == activeId })?.title
        } else {
            self.switchTargets = regularThreads
            self.activeThreadTitle = nil
        }
    }
}
