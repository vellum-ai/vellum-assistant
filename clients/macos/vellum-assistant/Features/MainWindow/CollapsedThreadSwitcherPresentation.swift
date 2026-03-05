import Foundation

struct CollapsedThreadSwitcherPresentation {
    let switchTargets: [ThreadModel]
    let activeThreadTitle: String?

    var showsSwitcher: Bool { !switchTargets.isEmpty }

    var accessibilityLabel: String {
        if let title = activeThreadTitle {
            return "Switch threads: \(title)"
        }
        return "Switch threads"
    }

    var accessibilityValue: String {
        switchTargets.isEmpty ? "" : "\(switchTargets.count) threads"
    }

    init(regularThreads: [ThreadModel], activeThreadId: UUID?) {
        if let activeId = activeThreadId {
            self.switchTargets = regularThreads.filter { $0.id != activeId }
            self.activeThreadTitle = regularThreads.first(where: { $0.id == activeId })?.title
        } else {
            self.switchTargets = regularThreads
            self.activeThreadTitle = nil
        }
    }
}
