import SwiftUI

/// Persists the expand/collapse state of thinking blocks across view
/// destruction and recreation. `ThinkingBlockView` uses `@State` internally,
/// but that state is lost whenever the hosting view subtree is torn down —
/// for example when `MessageListContentView` flips its `.if` min-height
/// wrapper at the start/end of an active turn, which destroys every
/// descendant `@State`. Lifting the state into this store, owned at the
/// `MessageListView` level (above the wrapper), lets expansion survive
/// those tree changes.
///
/// Only accessed from SwiftUI view bodies, which are implicitly
/// main-actor-isolated, so the mutations are safe in practice. The class
/// is not annotated `@MainActor` because `EnvironmentKey.defaultValue`
/// is a nonisolated protocol requirement and main-actor-isolated default
/// values violate Swift 6 isolation checking.
@Observable
final class ThinkingBlockExpansionStore: @unchecked Sendable {
    private var expandedKeys: Set<String> = []

    func isExpanded(_ key: String) -> Bool {
        expandedKeys.contains(key)
    }

    func toggle(_ key: String) {
        if expandedKeys.contains(key) {
            expandedKeys.remove(key)
        } else {
            expandedKeys.insert(key)
        }
    }
}

private struct ThinkingBlockExpansionStoreKey: EnvironmentKey {
    static let defaultValue = ThinkingBlockExpansionStore()
}

extension EnvironmentValues {
    var thinkingBlockExpansionStore: ThinkingBlockExpansionStore {
        get { self[ThinkingBlockExpansionStoreKey.self] }
        set { self[ThinkingBlockExpansionStoreKey.self] = newValue }
    }
}
