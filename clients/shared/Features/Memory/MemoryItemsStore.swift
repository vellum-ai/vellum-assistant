import Foundation

/// Shared store for memory item CRUD operations with filter state.
/// Used by both macOS and iOS memory list views.
@MainActor
public final class MemoryItemsStore: ObservableObject {
    @Published public var items: [MemoryItemPayload] = []
    @Published public var total: Int = 0
    @Published public var isLoading = false

    // Filter state
    @Published public var kindFilter: String? = nil
    @Published public var statusFilter: String? = "active"
    @Published public var searchText: String = ""
    @Published public var sortField: String = "lastSeenAt"
    @Published public var sortOrder: String = "desc"

    private let daemonClient: DaemonClient

    public init(daemonClient: DaemonClient) {
        self.daemonClient = daemonClient
    }

    /// Load memory items using the current filter state.
    public func loadItems() async {
        isLoading = true
        let response = await daemonClient.fetchMemoryItems(
            kind: kindFilter,
            status: statusFilter,
            search: searchText.isEmpty ? nil : searchText,
            sort: sortField,
            order: sortOrder
        )
        items = response?.items ?? []
        total = response?.total ?? 0
        isLoading = false
    }

    /// Create a new memory item and refresh the list on success.
    public func createItem(
        kind: String,
        subject: String,
        statement: String,
        importance: Double? = nil
    ) async -> MemoryItemPayload? {
        let item = await daemonClient.createMemoryItem(
            kind: kind,
            subject: subject,
            statement: statement,
            importance: importance
        )
        if item != nil { await loadItems() }
        return item
    }

    /// Update an existing memory item and refresh the list on success.
    public func updateItem(
        id: String,
        subject: String? = nil,
        statement: String? = nil,
        kind: String? = nil,
        status: String? = nil,
        importance: Double? = nil,
        verificationState: String? = nil
    ) async -> MemoryItemPayload? {
        let item = await daemonClient.updateMemoryItem(
            id: id,
            subject: subject,
            statement: statement,
            kind: kind,
            status: status,
            importance: importance,
            verificationState: verificationState
        )
        if item != nil { await loadItems() }
        return item
    }

    /// Delete a memory item and refresh the list on success.
    public func deleteItem(id: String) async -> Bool {
        let success = await daemonClient.deleteMemoryItem(id: id)
        if success { await loadItems() }
        return success
    }
}
