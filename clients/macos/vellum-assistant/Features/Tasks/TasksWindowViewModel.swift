import os
import SwiftUI
import VellumAssistantShared

/// Centralizes task queue state and daemon callbacks so refresh triggers
/// are deterministic (set up in `init`) rather than relying on `onAppear`.
@MainActor
class TasksWindowViewModel: ObservableObject {
    @Published var items: [IPCWorkItemsListResponseItem] = []
    @Published var isLoading = true
    @Published var errorMessage: String?

    private let logger = Logger(subsystem: "com.vellum.vellum-assistant", category: "TasksWindow")
    private let daemonClient: DaemonClient
    private var refreshTask: Task<Void, Never>?
    /// Tracks work item IDs with an in-flight run request so we can
    /// detect duplicate taps and disable the Run button in the view.
    @Published var runInFlightIds: Set<String> = []
    /// Tracks IDs where the run request timed out without a daemon response,
    /// so the view can show a recoverable "no response" warning.
    @Published var runTimeoutIds: Set<String> = []

    /// The currently selected item for output detail viewing, or nil when
    /// the detail sheet is dismissed.
    @Published var selectedOutputItem: IPCWorkItemsListResponseItem?
    /// Loading/loaded/error state for the output detail sheet.
    @Published var outputState: TaskOutputState = .loading

    /// Handles for pending timeout tasks keyed by work item ID, so we can
    /// cancel the timer when the daemon responds before the deadline.
    private var runTimeoutTasks: [String: Task<Void, Never>] = [:]

    /// How long to wait for a daemon run-task response before treating
    /// the request as timed out. 10 seconds is generous enough to cover
    /// normal latency while still recovering from connection drops quickly.
    private static let runTimeoutSeconds: UInt64 = 10

    init(daemonClient: DaemonClient) {
        self.daemonClient = daemonClient
        setupCallbacks()
        fetchItems()
    }

    /// Wires up daemon client callbacks for list responses and change
    /// notifications. Called once from `init` so callbacks are active for the
    /// entire lifetime of the view model, not just after `onAppear`.
    private func setupCallbacks() {
        daemonClient.onWorkItemsListResponse = { [weak self] response in
            self?.items = response.items
            self?.isLoading = false
            // A fresh list response means the daemon is alive — clear any
            // stale timeout warnings since the user can now retry.
            self?.runTimeoutIds.removeAll()
        }

        // Debounce rapid broadcasts so multiple mutations coalesce
        // into a single re-fetch instead of N overlapping calls.
        let scheduleRefresh = { [weak self] in
            self?.refreshTask?.cancel()
            self?.refreshTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 300_000_000) // 300ms
                guard !Task.isCancelled else { return }
                self?.fetchItems()
            }
        }

        daemonClient.onWorkItemStatusChanged = { [weak self] notification in
            // The daemon confirmed a status transition — clear in-flight tracking
            // so subsequent run requests for this item are allowed.
            let id = notification.item.id
            self?.runInFlightIds.remove(id)
            self?.cancelRunTimeout(id: id)
            scheduleRefresh()
        }
        daemonClient.onTasksChanged = { _ in scheduleRefresh() }

        daemonClient.onWorkItemRunTaskResponse = { [weak self] response in
            guard let self else { return }
            self.runInFlightIds.remove(response.id)
            self.cancelRunTimeout(id: response.id)
            if !response.success {
                self.logger.error("onWorkItemRunTaskResponse: run failed for id=\(response.id, privacy: .public) errorCode=\(response.errorCode ?? "none", privacy: .public) error=\(response.error ?? "none", privacy: .public)")
                self.fetchItems()
            }
        }

        daemonClient.onWorkItemDeleteResponse = { [weak self] response in
            guard let self else { return }
            if !response.success {
                self.logger.warning("onWorkItemDeleteResponse: server rejected delete for id=\(response.id, privacy: .public)")
                self.fetchItems()
            }
        }

        daemonClient.onWorkItemOutputResponse = { [weak self] response in
            guard let self else { return }
            // Only update if the response matches the currently selected item
            guard self.selectedOutputItem?.id == response.id else { return }
            if response.success, let output = response.output {
                self.outputState = .loaded(output)
            } else {
                self.outputState = .error(response.error ?? "Output not available for this task.")
            }
        }
    }

    func fetchItems() {
        isLoading = items.isEmpty
        errorMessage = nil
        do {
            try daemonClient.sendWorkItemsList()
        } catch {
            logger.error("fetchItems failed: \(error.localizedDescription, privacy: .public)")
            errorMessage = error.localizedDescription
            isLoading = false
        }
    }

    func runTask(id: String) {
        let item = items.first { $0.id == id }
        let status = item?.status ?? "unknown"
        let alreadyInFlight = runInFlightIds.contains(id)

        logger.info("runTask: id=\(id, privacy: .public) status=\(status, privacy: .public) inFlight=\(alreadyInFlight)")

        if alreadyInFlight {
            logger.warning("runTask: skipping duplicate run request for id=\(id, privacy: .public)")
            return
        }

        // Clear any previous timeout warning for this item before retrying.
        runTimeoutIds.remove(id)

        runInFlightIds.insert(id)
        startRunTimeout(id: id)
        do {
            try daemonClient.sendWorkItemRunTask(id: id)
        } catch {
            logger.error("runTask: transport error for id=\(id, privacy: .public): \(error.localizedDescription, privacy: .public)")
            runInFlightIds.remove(id)
            cancelRunTimeout(id: id)
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Run Timeout

    /// Starts a delayed task that fires after `runTimeoutSeconds`. If the ID
    /// is still in `runInFlightIds` when the timer expires, we treat it as a
    /// dropped response: remove the in-flight state and mark it as timed out
    /// so the view can show a recoverable warning.
    private func startRunTimeout(id: String) {
        cancelRunTimeout(id: id)
        runTimeoutTasks[id] = Task { [weak self] in
            try? await Task.sleep(nanoseconds: Self.runTimeoutSeconds * 1_000_000_000)
            guard !Task.isCancelled, let self else { return }
            guard self.runInFlightIds.contains(id) else { return }
            self.logger.warning("runTask timeout: no response after \(Self.runTimeoutSeconds)s for id=\(id, privacy: .public)")
            self.runInFlightIds.remove(id)
            self.runTimeoutIds.insert(id)
            self.runTimeoutTasks.removeValue(forKey: id)
        }
    }

    /// Cancels a pending timeout task and clears its tracking state.
    private func cancelRunTimeout(id: String) {
        runTimeoutTasks[id]?.cancel()
        runTimeoutTasks.removeValue(forKey: id)
        runTimeoutIds.remove(id)
    }

    func completeTask(id: String) {
        logger.info("completeTask: id=\(id, privacy: .public)")
        do {
            try daemonClient.sendWorkItemComplete(id: id)
            items.removeAll { $0.id == id }
        } catch {
            logger.error("completeTask: transport error for id=\(id, privacy: .public): \(error.localizedDescription, privacy: .public)")
            errorMessage = error.localizedDescription
        }
    }

    func removeTask(id: String) {
        logger.info("removeTask: id=\(id, privacy: .public)")
        let snapshot = items

        withAnimation(.linear(duration: 0.15)) {
            items.removeAll { $0.id == id }
        }

        do {
            try daemonClient.sendWorkItemDelete(id: id)
        } catch {
            logger.error("removeTask: transport error for id=\(id, privacy: .public): \(error.localizedDescription, privacy: .public)")
            withAnimation(.linear(duration: 0.15)) {
                items = snapshot
            }
            errorMessage = error.localizedDescription
        }
    }

    /// Whether a task's status indicates it may have output to display.
    func taskHasOutput(_ item: IPCWorkItemsListResponseItem) -> Bool {
        let status = WorkItemStatus(rawStatus: item.status)
        switch status {
        case .awaitingReview, .done, .failed: return true
        default: return false
        }
    }

    /// Opens the output detail sheet for the given item and fetches its
    /// output from the daemon.
    func fetchOutput(for item: IPCWorkItemsListResponseItem) {
        logger.info("fetchOutput: id=\(item.id, privacy: .public)")
        selectedOutputItem = item
        outputState = .loading
        do {
            try daemonClient.sendWorkItemOutput(id: item.id)
        } catch {
            logger.error("fetchOutput: transport error for id=\(item.id, privacy: .public): \(error.localizedDescription, privacy: .public)")
            outputState = .error(error.localizedDescription)
        }
    }

    /// Dismisses the output detail sheet.
    func dismissOutput() {
        selectedOutputItem = nil
    }

    func updatePriority(id: String, tier: Double) {
        // Snapshot for rollback on failure
        let snapshot = items

        // Optimistic local update: replace the item's priority and re-sort
        if let index = items.firstIndex(where: { $0.id == id }) {
            var updated = items
            updated[index] = updated[index].withPriorityTier(tier)
            updated.sort {
                if $0.priorityTier != $1.priorityTier {
                    return $0.priorityTier < $1.priorityTier
                }
                if let s0 = $0.sortIndex, let s1 = $1.sortIndex, s0 != s1 {
                    return s0 < s1
                }
                return $0.updatedAt > $1.updatedAt
            }
            // Fast linear transition to avoid jittery spring animations on reorder
            withAnimation(.linear(duration: 0.15)) {
                items = updated
            }
        }

        do {
            try daemonClient.sendWorkItemUpdate(id: id, priorityTier: tier)
        } catch {
            logger.error("updatePriority: transport error for id=\(id, privacy: .public): \(error.localizedDescription, privacy: .public)")
            // Rollback to pre-update state
            withAnimation(.linear(duration: 0.15)) {
                items = snapshot
            }
            errorMessage = error.localizedDescription
        }
    }
}
