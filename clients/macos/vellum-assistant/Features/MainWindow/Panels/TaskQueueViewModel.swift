import os
import SwiftUI
import VellumAssistantShared

/// Centralizes task queue state and daemon callbacks for the macOS Task Queue panel.
@MainActor
class TaskQueueViewModel: ObservableObject {
    @Published var items: [IPCWorkItemsListResponseItem] = []
    @Published var isLoading = true
    @Published var errorMessage: String?

    /// Tracks work item IDs with an in-flight run request to prevent duplicate taps.
    @Published var runInFlightIds: Set<String> = []
    /// Tracks IDs where the run request timed out without a daemon response.
    @Published var runTimeoutIds: Set<String> = []
    /// Tracks work item IDs with an in-flight cancel request.
    @Published var cancelInFlightIds: Set<String> = []

    /// The currently selected item for output detail viewing.
    @Published var selectedOutputItem: IPCWorkItemsListResponseItem?
    /// Loading/loaded/error state for the output detail sheet.
    @Published var outputState: TaskOutputState = .loading

    /// The item currently undergoing permission preflight.
    @Published var preflightItem: IPCWorkItemsListResponseItem?
    /// Loading/loaded/error state for the preflight sheet.
    @Published var preflightState: TaskPreflightState = .loading

    /// Filter for which status to display. nil = all statuses.
    @Published var statusFilter: WorkItemStatusFilter = .active

    private let logger = Logger(subsystem: "com.vellum.vellum-assistant", category: "TaskQueueViewModel")
    private let daemonClient: DaemonClient
    private var refreshTask: Task<Void, Never>?

    /// Tracks the item awaiting a preflight response from the daemon.
    private var pendingPreflightItem: IPCWorkItemsListResponseItem?

    private var runTimeoutTasks: [String: Task<Void, Never>] = [:]

    /// How long to wait for a daemon run-task response before treating
    /// the request as timed out.
    private static let runTimeoutSeconds: UInt64 = 10

    init(daemonClient: DaemonClient) {
        self.daemonClient = daemonClient
        setupCallbacks()
        fetchItems()
    }

    // MARK: - Filtered Items

    var filteredItems: [IPCWorkItemsListResponseItem] {
        switch statusFilter {
        case .all:
            return items
        case .active:
            return items.filter {
                let s = WorkItemStatus(rawStatus: $0.status)
                switch s {
                case .queued, .running, .awaitingReview: return true
                default: return false
                }
            }
        case .completed:
            return items.filter {
                let s = WorkItemStatus(rawStatus: $0.status)
                return s == .done
            }
        case .failed:
            return items.filter {
                let s = WorkItemStatus(rawStatus: $0.status)
                return s == .failed || s == .cancelled
            }
        }
    }

    // MARK: - Callback Setup

    private func setupCallbacks() {
        daemonClient.onWorkItemsListResponse = { [weak self] response in
            self?.items = response.items
            self?.isLoading = false
            self?.runTimeoutIds.removeAll()
            if let self {
                let nonRunningIds = Set(response.items
                    .filter { WorkItemStatus(rawStatus: $0.status) != .running }
                    .map(\.id))
                self.runInFlightIds.subtract(nonRunningIds)
            }
        }

        let scheduleRefresh = { [weak self] in
            self?.refreshTask?.cancel()
            self?.refreshTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 300_000_000)
                guard !Task.isCancelled else { return }
                self?.fetchItems()
            }
        }

        daemonClient.onWorkItemStatusChanged = { [weak self] notification in
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
                self.logger.error("Run failed for id=\(response.id, privacy: .public) errorCode=\(response.errorCode ?? "none", privacy: .public)")
                if response.errorCode == "permission_required",
                   let item = self.items.first(where: { $0.id == response.id }) {
                    self.initiateRun(item: item)
                } else {
                    self.errorMessage = response.error ?? "Failed to run task"
                }
                self.fetchItems()
            }
        }

        daemonClient.onWorkItemDeleteResponse = { [weak self] response in
            guard let self else { return }
            if !response.success {
                self.logger.warning("Server rejected delete for id=\(response.id, privacy: .public)")
                self.fetchItems()
            }
        }

        daemonClient.onWorkItemOutputResponse = { [weak self] response in
            guard let self else { return }
            guard self.selectedOutputItem?.id == response.id else { return }
            if response.success, let output = response.output {
                self.outputState = .loaded(output)
            } else {
                self.outputState = .error(response.error ?? "Output not available for this task.")
            }
        }

        daemonClient.onWorkItemPreflightResponse = { [weak self] response in
            guard let self else { return }
            guard self.pendingPreflightItem?.id == response.id else { return }
            if response.success, let permissions = response.permissions {
                if permissions.isEmpty {
                    self.pendingPreflightItem = nil
                    self.runTask(id: response.id)
                } else {
                    self.preflightItem = self.pendingPreflightItem
                    self.pendingPreflightItem = nil
                    self.preflightState = .loaded(permissions)
                }
            } else {
                self.pendingPreflightItem = nil
                self.errorMessage = response.error ?? "Failed to check permissions."
            }
        }

        daemonClient.onWorkItemApprovePermissionsResponse = { [weak self] response in
            guard let self else { return }
            if response.success {
                let itemId = response.id
                self.dismissPreflight()
                self.runTask(id: itemId)
            } else {
                self.preflightState = .error(response.error ?? "Failed to save permission approvals.")
            }
        }

        daemonClient.onWorkItemCancelResponse = { [weak self] response in
            guard let self else { return }
            self.cancelInFlightIds.remove(response.id)
            if !response.success {
                self.logger.error("Cancel failed for id=\(response.id, privacy: .public)")
                self.errorMessage = response.error ?? "Failed to cancel task"
            }
            self.fetchItems()
        }
    }

    // MARK: - Data

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

    /// Whether a task's status indicates it may have output to display.
    func taskHasOutput(_ item: IPCWorkItemsListResponseItem) -> Bool {
        let status = WorkItemStatus(rawStatus: item.status)
        switch status {
        case .awaitingReview, .done, .failed: return true
        default: return false
        }
    }

    // MARK: - Run / Preflight

    /// Initiates the run flow via a preflight check. The permission sheet only
    /// appears if the daemon reports non-empty permissions.
    func initiateRun(item: IPCWorkItemsListResponseItem) {
        logger.info("initiateRun: id=\(item.id, privacy: .public)")
        guard !runInFlightIds.contains(item.id) else {
            logger.warning("initiateRun: skipping — already in flight for id=\(item.id, privacy: .public)")
            return
        }
        pendingPreflightItem = item
        preflightState = .loading
        do {
            try daemonClient.sendWorkItemPreflight(id: item.id)
        } catch {
            logger.error("initiateRun: preflight transport error for id=\(item.id, privacy: .public): \(error.localizedDescription, privacy: .public)")
            pendingPreflightItem = nil
            errorMessage = error.localizedDescription
        }
    }

    func approveAndRun(id: String, approvedTools: [String]) {
        logger.info("approveAndRun: id=\(id, privacy: .public)")
        do {
            try daemonClient.sendWorkItemApprovePermissions(id: id, approvedTools: approvedTools)
        } catch {
            logger.error("approveAndRun: transport error for id=\(id, privacy: .public): \(error.localizedDescription, privacy: .public)")
            preflightState = .error(error.localizedDescription)
        }
    }

    func dismissPreflight() { preflightItem = nil }

    func runTask(id: String) {
        guard !runInFlightIds.contains(id) else {
            logger.warning("runTask: skipping duplicate run request for id=\(id, privacy: .public)")
            return
        }
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

    // MARK: - Cancel

    func cancelTask(id: String) {
        logger.info("cancelTask: id=\(id, privacy: .public)")
        guard !cancelInFlightIds.contains(id) else { return }
        cancelInFlightIds.insert(id)
        do {
            try daemonClient.sendWorkItemCancel(id: id)
        } catch {
            logger.error("cancelTask: transport error for id=\(id, privacy: .public): \(error.localizedDescription, privacy: .public)")
            cancelInFlightIds.remove(id)
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Remove

    func removeTask(id: String) {
        logger.info("removeTask: id=\(id, privacy: .public)")
        let snapshot = items
        withAnimation { items.removeAll { $0.id == id } }
        do {
            try daemonClient.sendWorkItemDelete(id: id)
        } catch {
            logger.error("removeTask: transport error for id=\(id, privacy: .public): \(error.localizedDescription, privacy: .public)")
            withAnimation { items = snapshot }
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Output

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

    func dismissOutput() { selectedOutputItem = nil }

    // MARK: - Priority

    func updatePriority(id: String, tier: Double) {
        let snapshot = items
        if let index = items.firstIndex(where: { $0.id == id }) {
            var updated = items
            updated[index] = updated[index].withPriorityTier(tier)
            updated.sort {
                if $0.priorityTier != $1.priorityTier { return $0.priorityTier < $1.priorityTier }
                if let s0 = $0.sortIndex, let s1 = $1.sortIndex, s0 != s1 { return s0 < s1 }
                return $0.updatedAt > $1.updatedAt
            }
            withAnimation(.linear(duration: 0.15)) { items = updated }
        }
        do {
            try daemonClient.sendWorkItemUpdate(id: id, priorityTier: tier)
        } catch {
            logger.error("updatePriority: transport error for id=\(id, privacy: .public): \(error.localizedDescription, privacy: .public)")
            withAnimation(.linear(duration: 0.15)) { items = snapshot }
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Run Timeout

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

    private func cancelRunTimeout(id: String) {
        runTimeoutTasks[id]?.cancel()
        runTimeoutTasks.removeValue(forKey: id)
        runTimeoutIds.remove(id)
    }
}

// MARK: - State Types

/// Loading/loaded/error state for fetching task output.
enum TaskOutputState {
    case loading
    case loaded(IPCWorkItemOutputResponseOutput)
    case error(String)
}

/// Loading/loaded/error state for the permission preflight check.
enum TaskPreflightState {
    case loading
    case loaded([IPCWorkItemPreflightResponsePermission])
    case error(String)
}

/// Filter options for the task queue list.
enum WorkItemStatusFilter: String, CaseIterable {
    case all = "All"
    case active = "Active"
    case completed = "Completed"
    case failed = "Failed"
}
