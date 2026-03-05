import SwiftUI
import VellumAssistantShared

/// Drop delegate for reordering scheduled threads within the same schedule group.
/// Returns `.move` operation to show a reorder cursor instead of the copy/plus icon.
struct ScheduleReorderDropDelegate: DropDelegate {
    let targetThread: ThreadModel
    let sidebar: SidebarInteractionState
    let threadManager: ThreadManager

    func validateDrop(info: DropInfo) -> Bool {
        guard let dragId = sidebar.draggingThreadId,
              dragId != targetThread.id,
              let sourceThread = threadManager.visibleThreads.first(where: { $0.id == dragId }),
              sourceThread.isScheduleThread,
              sourceThread.scheduleJobId == targetThread.scheduleJobId
        else { return false }
        return true
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        return DropProposal(operation: .move)
    }

    func dropEntered(info: DropInfo) {
        guard let dragId = sidebar.draggingThreadId,
              dragId != targetThread.id,
              let sourceThread = threadManager.visibleThreads.first(where: { $0.id == dragId }),
              sourceThread.isScheduleThread,
              sourceThread.scheduleJobId == targetThread.scheduleJobId
        else { return }

        sidebar.dropTargetThreadId = targetThread.id
        let visible = threadManager.visibleThreads
        let sIdx = visible.firstIndex(where: { $0.id == dragId }) ?? 0
        let tIdx = visible.firstIndex(where: { $0.id == targetThread.id }) ?? 0
        sidebar.dropIndicatorAtBottom = sIdx < tIdx
    }

    func dropExited(info: DropInfo) {
        if sidebar.dropTargetThreadId == targetThread.id {
            sidebar.dropTargetThreadId = nil
        }
    }

    func performDrop(info: DropInfo) -> Bool {
        let sourceId = sidebar.draggingThreadId
        sidebar.dropTargetThreadId = nil
        sidebar.draggingThreadId = nil
        guard let sourceId = sourceId, sourceId != targetThread.id else { return false }
        return threadManager.moveThread(sourceId: sourceId, targetId: targetThread.id)
    }
}

/// Drop delegate for the collapsed schedule group header.
/// Targets the first thread in the group; only accepts drops from the same schedule group.
struct ScheduleGroupHeaderDropDelegate: DropDelegate {
    let group: (key: String, label: String, threads: [ThreadModel])
    let sidebar: SidebarInteractionState
    let threadManager: ThreadManager

    private var firstThread: ThreadModel? { group.threads.first }

    func validateDrop(info: DropInfo) -> Bool {
        guard let firstThread = firstThread,
              let dragId = sidebar.draggingThreadId,
              dragId != firstThread.id,
              let sourceThread = threadManager.visibleThreads.first(where: { $0.id == dragId }),
              sourceThread.isScheduleThread,
              sourceThread.scheduleJobId == firstThread.scheduleJobId
        else { return false }
        return true
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        return DropProposal(operation: .move)
    }

    func dropEntered(info: DropInfo) {
        guard let firstThread = firstThread,
              let dragId = sidebar.draggingThreadId,
              dragId != firstThread.id,
              let sourceThread = threadManager.visibleThreads.first(where: { $0.id == dragId }),
              sourceThread.isScheduleThread,
              sourceThread.scheduleJobId == firstThread.scheduleJobId
        else { return }

        sidebar.dropTargetThreadId = firstThread.id
        sidebar.dropIndicatorAtBottom = false
    }

    func dropExited(info: DropInfo) {
        if let firstThread = firstThread, sidebar.dropTargetThreadId == firstThread.id {
            sidebar.dropTargetThreadId = nil
        }
    }

    func performDrop(info: DropInfo) -> Bool {
        let sourceId = sidebar.draggingThreadId
        sidebar.dropTargetThreadId = nil
        sidebar.draggingThreadId = nil
        guard let firstThread = firstThread,
              let sourceId = sourceId,
              sourceId != firstThread.id
        else { return false }
        return threadManager.moveThread(sourceId: sourceId, targetId: firstThread.id)
    }
}
