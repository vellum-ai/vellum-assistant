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

    private let memoryItemClient: MemoryItemClientProtocol

    public init(memoryItemClient: MemoryItemClientProtocol) {
        self.memoryItemClient = memoryItemClient
    }

    /// Load memory items using the current filter state.
    public func loadItems() async {
        isLoading = true
        let response = await memoryItemClient.fetchMemoryItems(
            kind: kindFilter,
            status: statusFilter,
            search: searchText.isEmpty ? nil : searchText,
            sort: sortField,
            order: sortOrder,
            limit: 100,
            offset: 0
        )
        if let response {
            items = response.items
            total = response.total
        }
        isLoading = false
    }

    /// Create a new memory item and refresh the list on success.
    public func createItem(
        kind: String,
        subject: String,
        statement: String,
        importance: Double? = nil
    ) async -> MemoryItemPayload? {
        let item = await memoryItemClient.createMemoryItem(
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
        let item = await memoryItemClient.updateMemoryItem(
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

    /// Fetch the full detail for a single memory item (resolves supersession subjects)
    /// and update it in the local items array. Returns the fetched item, or nil on failure.
    @discardableResult
    public func fetchDetail(id: String) async -> MemoryItemPayload? {
        guard let detail = await memoryItemClient.fetchMemoryItem(id: id) else { return nil }
        if let idx = items.firstIndex(where: { $0.id == id }) {
            items[idx] = detail
        }
        return detail
    }

    /// Delete a memory item and refresh the list on success.
    public func deleteItem(id: String) async -> Bool {
        let success = await memoryItemClient.deleteMemoryItem(id: id)
        if success { await loadItems() }
        return success
    }
}
