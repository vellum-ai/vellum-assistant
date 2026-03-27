import Foundation

/// Thin @MainActor coordinator that wraps `SurfaceRefetchManager` and owns the
/// per-surface task dictionary, keeping refetch lifecycle separate from the view model.
/// Not @Observable — holds no view-facing state.
@MainActor
public final class SurfaceRefetchCoordinator {
    /// Callback invoked on the main actor with the refetch result so the caller
    /// can apply it to the message list.
    public typealias ApplyResult = (String, SurfaceRefetchManager.RefetchResult) -> Void

    private let surfaceRefetchManager: SurfaceRefetchManager
    private let applyResult: ApplyResult

    /// In-flight refetch tasks, keyed by surface ID for cancellation.
    private var refetchTasks: [String: Task<Void, Never>] = [:]

    public init(
        surfaceRefetchManager: SurfaceRefetchManager,
        applyResult: @escaping ApplyResult
    ) {
        self.surfaceRefetchManager = surfaceRefetchManager
        self.applyResult = applyResult
    }

    deinit {
        for task in refetchTasks.values { task.cancel() }
    }

    /// Re-fetch the full payload for a stripped surface. The result is applied
    /// via the `applyResult` callback provided at init.
    public func refetchStrippedSurface(surfaceId: String, conversationId: String) {
        guard refetchTasks[surfaceId] == nil else { return }
        refetchTasks[surfaceId] = Task { @MainActor [weak self] in
            defer { self?.refetchTasks.removeValue(forKey: surfaceId) }
            guard let self else { return }
            let result = await self.surfaceRefetchManager.enqueue(
                surfaceId: surfaceId,
                conversationId: conversationId
            )
            self.applyResult(surfaceId, result)
        }
    }

    /// Cancel all in-flight surface refetch tasks and reset the manager's
    /// failure counts so surfaces can be retried in the new conversation.
    public func cancelRefetchTasks() {
        for task in refetchTasks.values { task.cancel() }
        refetchTasks.removeAll()
        Task { await surfaceRefetchManager.resetFailureCounts() }
    }
}
