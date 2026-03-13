import SwiftUI
import VellumAssistantShared

// MARK: - Sort Options

private enum MemorySortOption: String, CaseIterable {
    case newest = "Newest"
    case oldest = "Oldest"
    case importance = "Importance"
    case kind = "Kind"

    var sortField: String {
        switch self {
        case .newest, .oldest: return "lastSeenAt"
        case .importance: return "importance"
        case .kind: return "kind"
        }
    }

    var sortOrder: String {
        switch self {
        case .newest, .importance: return "desc"
        case .oldest, .kind: return "asc"
        }
    }
}

private enum MemoryStatusFilter: String, CaseIterable {
    case active = "Active"
    case inactive = "Inactive"
    case all = "All"

    /// API value sent as the `status` query parameter.
    var apiValue: String {
        switch self {
        case .active: return "active"
        case .inactive: return "inactive"
        case .all: return "all"
        }
    }
}

// MARK: - Memories Panel

struct MemoriesPanel: View {
    let daemonClient: DaemonClient
    @StateObject private var store: MemoryItemsStore
    @State private var showCreateSheet = false
    @State private var selectedItem: MemoryItemPayload?
    @State private var selectedKind: MemoryKind?
    @State private var statusFilter: MemoryStatusFilter = .active
    @State private var sortOption: MemorySortOption = .newest
    @State private var searchDebounceTask: Task<Void, Never>?

    init(daemonClient: DaemonClient) {
        self.daemonClient = daemonClient
        _store = StateObject(wrappedValue: MemoryItemsStore(daemonClient: daemonClient))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            filterBar
            Divider().background(VColor.borderDisabled)
            contentView
        }
        .task { await store.loadItems() }
        .onDisappear {
            searchDebounceTask?.cancel()
            searchDebounceTask = nil
        }
        .sheet(item: $selectedItem) { item in
            MemoryItemDetailSheet(
                item: item,
                store: store,
                onDismiss: { selectedItem = nil }
            )
        }
        .sheet(isPresented: $showCreateSheet) {
            MemoryItemCreateSheet(
                store: store,
                onDismiss: { showCreateSheet = false }
            )
        }
    }

    // MARK: - Filter Bar

    @ViewBuilder
    private var filterBar: some View {
        VStack(spacing: VSpacing.lg) {
            // Row 1: Search, Status, Sort, New
            HStack(spacing: VSpacing.sm) {
                VSearchBar(placeholder: "Search memories...", text: $store.searchText)
                    .onChange(of: store.searchText) {
                        searchDebounceTask?.cancel()
                        searchDebounceTask = Task {
                            try? await Task.sleep(nanoseconds: 300_000_000)
                            guard !Task.isCancelled else { return }
                            await store.loadItems()
                        }
                    }

                VDropdown(
                    placeholder: "Status",
                    selection: $statusFilter,
                    options: MemoryStatusFilter.allCases.map { ($0.rawValue, $0) }
                )
                .frame(width: 110)
                .onChange(of: statusFilter) {
                    store.statusFilter = statusFilter.apiValue
                    Task { await store.loadItems() }
                }

                VDropdown(
                    placeholder: "Sort",
                    selection: $sortOption,
                    options: MemorySortOption.allCases.map { ($0.rawValue, $0) }
                )
                .frame(width: 120)
                .onChange(of: sortOption) {
                    store.sortField = sortOption.sortField
                    store.sortOrder = sortOption.sortOrder
                    Task { await store.loadItems() }
                }

                VButton(label: "New", icon: VIcon.plus.rawValue, style: .primary) {
                    showCreateSheet = true
                }
                .accessibilityLabel("Create new memory")
            }

            // Row 2: Topic chips
            HStack(spacing: VSpacing.sm) {
                Text("Topic:")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentTertiary)

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: VSpacing.xs) {
                        VButton(
                            label: "All",
                            style: selectedKind == nil ? .primary : .outlined,
                            size: .pill
                        ) {
                            selectedKind = nil
                            store.kindFilter = nil
                            Task { await store.loadItems() }
                        }
                        .accessibilityLabel("All filter")
                        .accessibilityAddTraits(selectedKind == nil ? .isSelected : [])

                        ForEach(MemoryKind.allCases) { kind in
                            VButton(
                                label: kind.label,
                                style: selectedKind == kind ? .primary : .outlined,
                                size: .pill
                            ) {
                                selectedKind = kind
                                store.kindFilter = kind.rawValue
                                Task { await store.loadItems() }
                            }
                            .accessibilityLabel("\(kind.label) filter")
                            .accessibilityAddTraits(selectedKind == kind ? .isSelected : [])
                        }
                    }
                }
            }
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.top, VSpacing.sm)
        .padding(.bottom, VSpacing.md)
    }

    // MARK: - Content View

    @ViewBuilder
    private var contentView: some View {
        if store.isLoading && store.items.isEmpty {
            VStack {
                Spacer()
                VLoadingIndicator()
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if store.items.isEmpty {
            VEmptyState(
                title: "No Memories Yet",
                subtitle: "Your assistant learns and remembers things from your conversations. Memories will appear here as they're created.",
                icon: VIcon.bookOpen.rawValue
            )
        } else {
            ScrollView {
                LazyVStack(spacing: VSpacing.xs) {
                    ForEach(store.items) { item in
                        MemoryItemRow(
                            item: item,
                            onSelect: { selectedItem = item },
                            onDelete: {
                                Task { _ = await store.deleteItem(id: item.id) }
                            }
                        )
                    }
                }
                .padding(VSpacing.md)
                .background { OverlayScrollerStyle() }
            }
            .scrollContentBackground(.hidden)
        }
    }
}

