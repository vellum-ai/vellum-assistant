import SwiftUI

/// Persists the expand/collapse state of file preview cards across view
/// destruction and recreation. Lifting the state into this store, owned at the
/// `MessageListView` level (above the wrapper), lets expansion survive
/// tree changes that would destroy `@State` in descendant views.
///
/// Only accessed from SwiftUI view bodies, which are implicitly
/// main-actor-isolated, so the mutations are safe in practice. The class
/// is not annotated `@MainActor` because `EnvironmentKey.defaultValue`
/// is a nonisolated protocol requirement and main-actor-isolated default
/// values violate Swift 6 isolation checking.
@Observable
final class FilePreviewExpansionStore: @unchecked Sendable {
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

private struct FilePreviewExpansionStoreKey: EnvironmentKey {
    static let defaultValue = FilePreviewExpansionStore()
}

extension EnvironmentValues {
    var filePreviewExpansionStore: FilePreviewExpansionStore {
        get { self[FilePreviewExpansionStoreKey.self] }
        set { self[FilePreviewExpansionStoreKey.self] = newValue }
    }
}
