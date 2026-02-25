import Foundation

/// Groups sidebar-local interaction state (hover tracking, expand/collapse toggles,
/// rename state) into a single @Observable object. With the Observation framework,
/// only views that read specific properties re-evaluate when those properties change --
/// e.g., hover changes don't trigger recomputation of the main content area.
@MainActor @Observable
final class SidebarInteractionState {
    var isHoveredThread: UUID?
    var isHoveredApp: String?
    var threadPendingDeletion: UUID?
    var renamingThreadId: UUID?
    var renameText: String = ""
    var showAllThreads: Bool = false
    var showAllScheduleThreads: Bool = false
    var showAllApps: Bool = false

    /// Cancel pending archive when the user hovers a different thread.
    func handleHoverChange(newValue: UUID?) {
        if let pending = threadPendingDeletion, let newValue, newValue != pending {
            threadPendingDeletion = nil
        }
    }
}
