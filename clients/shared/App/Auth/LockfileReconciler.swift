import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "LockfileReconciler")

/// Brings the local lockfile's managed entries for the current environment in
/// line with the authoritative platform list.
///
/// - Removes any managed current-env entry whose `assistantId` is not in the
///   platform list (the assistant was retired elsewhere).
/// - Adds an entry for any platform assistant not yet in the lockfile (the
///   account already owns assistants on the platform that this device hasn't
///   seen yet — e.g. a fresh sign-in on a new install).
///
/// Non-managed entries (local / remote / docker / apple-container) and managed
/// entries belonging to a different environment are left untouched.
///
/// Callers must only invoke this when the platform list was successfully
/// fetched. Passing an empty list after a network failure would silently delete
/// every managed entry.
public enum LockfileReconciler {

    public struct Result: Equatable {
        public let added: [String]
        public let removed: [String]

        public var didChange: Bool { !added.isEmpty || !removed.isEmpty }

        public init(added: [String], removed: [String]) {
            self.added = added
            self.removed = removed
        }
    }

    @discardableResult
    public static func reconcile(
        platformAssistants: [PlatformAssistant],
        runtimeUrl: String = VellumEnvironment.resolvedPlatformURL,
        lockfilePath: String? = nil,
        now: () -> String = { Date().iso8601String }
    ) -> Result {
        let platformIds = Set(platformAssistants.map(\.id))

        // Step 1: drop managed current-env entries the platform no longer
        // knows about. Snapshot first so removals can't be invalidated by
        // intermediate writes.
        let snapshot = LockfileAssistant.loadAll(lockfilePath: lockfilePath)
        var removed: [String] = []
        for entry in snapshot
        where entry.isManaged && entry.isCurrentEnvironment && !platformIds.contains(entry.assistantId) {
            LockfileAssistant.removeEntry(
                assistantId: entry.assistantId,
                lockfilePath: lockfilePath
            )
            removed.append(entry.assistantId)
        }

        // Step 2: add platform assistants that aren't represented locally.
        let postRemoval = LockfileAssistant.loadAll(lockfilePath: lockfilePath)
        let lockfileIds = Set(postRemoval.map(\.assistantId))
        var added: [String] = []
        for assistant in platformAssistants where !lockfileIds.contains(assistant.id) {
            let persisted = LockfileAssistant.ensureManagedEntry(
                assistantId: assistant.id,
                runtimeUrl: runtimeUrl,
                hatchedAt: assistant.created_at ?? now(),
                lockfilePath: lockfilePath
            )
            if persisted {
                added.append(assistant.id)
            }
        }

        if !added.isEmpty || !removed.isEmpty {
            log.info(
                "reconciled lockfile against platform: +\(added.count, privacy: .public) -\(removed.count, privacy: .public)"
            )
        }

        return Result(added: added, removed: removed)
    }
}
