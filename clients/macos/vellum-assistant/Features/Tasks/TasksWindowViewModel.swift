import SwiftUI
import VellumAssistantShared

/// Centralizes task queue state and daemon callbacks so refresh triggers
/// are deterministic (set up in `init`) rather than relying on `onAppear`.
@MainActor
class TasksWindowViewModel: ObservableObject {
    @Published var items: [IPCWorkItemsListResponseItem] = []
    @Published var isLoading = true
    @Published var errorMessage: String?

    private let daemonClient: DaemonClient
    private var refreshTask: Task<Void, Never>?

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

        daemonClient.onWorkItemStatusChanged = { _ in scheduleRefresh() }
        daemonClient.onTasksChanged = { _ in scheduleRefresh() }

        daemonClient.onWorkItemDeleteResponse = { [weak self] response in
            guard let self else { return }
            if !response.success {
                self.fetchItems()
            }
        }
    }

    func fetchItems() {
        isLoading = items.isEmpty
        errorMessage = nil
        do {
            try daemonClient.sendWorkItemsList()
        } catch {
            errorMessage = error.localizedDescription
            isLoading = false
        }
    }

    func runTask(id: String) {
        do {
            try daemonClient.sendWorkItemRunTask(id: id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func completeTask(id: String) {
        do {
            try daemonClient.sendWorkItemComplete(id: id)
            items.removeAll { $0.id == id }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func removeTask(id: String) {
        let snapshot = items

        withAnimation(.linear(duration: 0.15)) {
            items.removeAll { $0.id == id }
        }

        do {
            try daemonClient.sendWorkItemDelete(id: id)
        } catch {
            withAnimation(.linear(duration: 0.15)) {
                items = snapshot
            }
            errorMessage = error.localizedDescription
        }
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
            // Rollback to pre-update state
            withAnimation(.linear(duration: 0.15)) {
                items = snapshot
            }
            errorMessage = error.localizedDescription
        }
    }
}
