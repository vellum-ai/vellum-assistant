import SwiftUI
import VellumAssistantShared

// MARK: - Sort Options

private enum MemorySortOption: String, CaseIterable {
    case newest = "Newest"
    case oldest = "Oldest"
    case importance = "Importance"
    case accessCount = "Access Count"
    case kind = "Kind"

    var sortField: String {
        switch self {
        case .newest, .oldest: return "lastSeenAt"
        case .importance: return "importance"
        case .accessCount: return "accessCount"
        case .kind: return "kind"
        }
    }

    var sortOrder: String {
        switch self {
        case .newest, .importance, .accessCount: return "desc"
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
    @Binding var focusedMemoryId: String?
    @StateObject private var store: MemoryItemsStore
    @State private var showCreateSheet = false
    @State private var selectedItem: MemoryItemPayload?
    @State private var selectedKind: MemoryKind?
    @State private var statusFilter: MemoryStatusFilter = .active
    @State private var sortOption: MemorySortOption = .newest
    @State private var searchDebounceTask: Task<Void, Never>?

    init(daemonClient: DaemonClient, focusedMemoryId: Binding<String?> = .constant(nil)) {
        self.daemonClient = daemonClient
        _focusedMemoryId = focusedMemoryId
        _store = StateObject(wrappedValue: MemoryItemsStore(memoryItemClient: MemoryItemClient()))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            filterBar
            HStack(alignment: .top, spacing: VSpacing.xxl) {
                kindSidebar
                contentView
            }
            .padding(.top, VSpacing.lg)
        }
        .task { await store.loadItems() }
        .task(id: focusedMemoryId) {
            guard let memoryId = focusedMemoryId else { return }
            if let item = await store.fetchDetail(id: memoryId) {
                selectedItem = item
            }
            focusedMemoryId = nil
        }
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
        HStack(spacing: VSpacing.sm) {
            VSearchBar(placeholder: "Search Memories", text: $store.searchText)
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
                options: MemoryStatusFilter.allCases.map { ($0.rawValue, $0) },
                maxWidth: 130
            )
            .onChange(of: statusFilter) {
                store.statusFilter = statusFilter.apiValue
                Task { await store.loadItems() }
            }

            VDropdown(
                placeholder: "Sort",
                selection: $sortOption,
                options: MemorySortOption.allCases.map { ($0.rawValue, $0) },
                maxWidth: 130
            )
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
        .padding(.top, VSpacing.sm)
    }

    // MARK: - Kind Sidebar

    @ViewBuilder
    private var kindSidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            kindSidebarItem(label: "All", isSelected: selectedKind == nil) {
                selectedKind = nil
                store.kindFilter = nil
                Task { await store.loadItems() }
            }
            .accessibilityAddTraits(selectedKind == nil ? .isSelected : [])

            ForEach(MemoryKind.allCases) { kind in
                kindSidebarItem(label: kind.label, isSelected: selectedKind == kind) {
                    selectedKind = kind
                    store.kindFilter = kind.rawValue
                    Task { await store.loadItems() }
                }
                .accessibilityAddTraits(selectedKind == kind ? .isSelected : [])
            }
        }
        .frame(width: 220)
    }

    @ViewBuilder
    private func kindSidebarItem(label: String, isSelected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(VFont.body)
                .foregroundColor(isSelected ? VColor.contentEmphasized : VColor.contentSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, VSpacing.sm)
                .padding(.horizontal, VSpacing.sm)
                .contentShape(Rectangle())
                .background(isSelected ? VColor.surfaceActive : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(label) filter")
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
                LazyVStack(spacing: VSpacing.sm) {
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
                .background { OverlayScrollerStyle() }
            }
            .scrollContentBackground(.hidden)
        }
    }
}
