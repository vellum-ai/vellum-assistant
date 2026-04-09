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

    var icon: VIcon {
        switch self {
        case .newest: return .arrowDown
        case .oldest: return .arrowUp
        case .importance: return .star
        case .kind: return .tag
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

    var icon: VIcon {
        switch self {
        case .active: return .circleCheck
        case .inactive: return .circleDashed
        case .all: return .circle
        }
    }

    var accessibilityDescription: String {
        switch self {
        case .active: return "Show currently referenced memories"
        case .inactive: return "Show archived or superseded memories"
        case .all: return "Show all memories including inactive"
        }
    }
}

// MARK: - Memories Panel

struct MemoriesPanel: View {
    let connectionManager: GatewayConnectionManager
    let assistantName: String
    var onImportMemory: ((String) -> Void)?
    @Binding var focusedMemoryId: String?
    @State private var store: MemoryItemsStore
    @State private var showImportSheet = false
    @State private var selectedItem: MemoryItemPayload?
    @State private var selectedKind: MemoryKind?
    @State private var statusFilter: MemoryStatusFilter = .active
    @State private var sortOption: MemorySortOption = .newest
    @State private var searchDebounceTask: Task<Void, Never>?
    init(connectionManager: GatewayConnectionManager, assistantName: String = "Your Assistant", onImportMemory: ((String) -> Void)? = nil, focusedMemoryId: Binding<String?> = .constant(nil)) {
        self.connectionManager = connectionManager
        self.assistantName = assistantName
        self.onImportMemory = onImportMemory
        _focusedMemoryId = focusedMemoryId
        _store = State(wrappedValue: MemoryItemsStore(memoryItemClient: MemoryItemClient()))
    }

    /// Kinds to show in the sidebar filter. Excludes system-managed kinds.
    private static let filterableKinds: [MemoryKind] = MemoryKind.userCreatableKinds

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            filterBar

            HStack(alignment: .top, spacing: VSpacing.xxl) {
                kindSidebar
                    .frame(width: 220)

                HStack(spacing: 0) {
                    // Memory list — takes remaining width
                    listContent
                        .frame(maxWidth: .infinity)

                    // Side detail panel — slides in from right
                    if let item = selectedItem {
                        Divider()
                        MemoryItemDetailSheet(
                            item: item,
                            store: store,
                            onDismiss: { withAnimation(VAnimation.panel) { selectedItem = nil } },
                            onNavigate: { newItem in
                                withAnimation(VAnimation.fast) { selectedItem = newItem }
                            }
                        )
                        .id(item.id)
                        .frame(width: 400)
                        .frame(maxHeight: .infinity)
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                        .onKeyPress(.escape) {
                            withAnimation(VAnimation.panel) { selectedItem = nil }
                            return .handled
                        }
                    }
                }
                .animation(VAnimation.panel, value: selectedItem?.id)
            }
            .padding(.top, VSpacing.lg)
        }
        .task { await store.loadItems() }
        .task(id: focusedMemoryId) {
            guard let memoryId = focusedMemoryId else { return }
            if let item = await store.fetchDetail(id: memoryId) {
                withAnimation(VAnimation.panel) { selectedItem = item }
            }
            focusedMemoryId = nil
        }
        .onDisappear {
            searchDebounceTask?.cancel()
            searchDebounceTask = nil
        }
        .sheet(isPresented: $showImportSheet) {
            MemoryImportSheet(
                assistantName: assistantName,
                onDismiss: { showImportSheet = false },
                onSubmit: onImportMemory.map { callback in
                    { pastedText in
                        let wrappedMessage = """
                            The following is a memory profile exported from another AI assistant. Please review it and internalize the information as memories about me. Treat each fact, preference, and detail as something to remember for future conversations.

                            ---

                            \(pastedText)
                            """
                        callback(wrappedMessage)
                    }
                }
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
                options: MemoryStatusFilter.allCases.map { VDropdownOption(label: $0.rawValue, value: $0, icon: $0.icon) },
                selection: $statusFilter,
                maxWidth: 158,
                onChange: { newStatus in
                    store.statusFilter = newStatus.apiValue
                    Task { await store.loadItems() }
                }
            )
            .accessibilityHint(statusFilter.accessibilityDescription)

            VDropdown(
                options: MemorySortOption.allCases.map { VDropdownOption(label: $0.rawValue, value: $0, icon: $0.icon) },
                selection: $sortOption,
                maxWidth: 158,
                onChange: { newSort in
                    store.sortField = newSort.sortField
                    store.sortOrder = newSort.sortOrder
                    Task { await store.loadItems() }
                }
            )

            VButton(label: "Import", icon: VIcon.arrowDownToLine.rawValue, style: .primary) {
                showImportSheet = true
            }
            .accessibilityLabel("Import memory")
        }
        .padding(.top, VSpacing.sm)
    }

    // MARK: - Kind Sidebar

    private var kindSidebar: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            kindFilterRow(icon: VIcon.layoutGrid.rawValue, label: "All", kind: nil)
            ForEach(Self.filterableKinds) { kind in
                kindFilterRow(icon: kind.icon, label: kind.label, kind: kind)
            }
        }
    }

    private func kindFilterRow(icon: String, label: String, kind: MemoryKind?) -> some View {
        VNavItem(
            icon: icon,
            label: label,
            isActive: selectedKind == kind,
            action: {
                withAnimation(VAnimation.fast) { selectedKind = kind }
                store.kindFilter = kind?.rawValue
                Task { await store.loadItems() }
            }
        ) {
            Text("\(kindCount(for: kind))")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
        .accessibilityLabel("\(label) filter")
        .accessibilityAddTraits(selectedKind == kind ? .isSelected : [])
    }

    private func kindCount(for kind: MemoryKind?) -> Int {
        guard let kind else {
            return store.kindCounts.values.reduce(0, +)
        }
        return store.kindCounts[kind.rawValue] ?? 0
    }

    // MARK: - List Content

    @ViewBuilder
    private var listContent: some View {
        if store.isLoading && store.items.isEmpty {
            VStack {
                Spacer()
                VLoadingIndicator()
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if store.items.isEmpty {
            VEmptyState(
                title: selectedKind == nil ? "No Memories Yet" : "No \(selectedKind!.label) Memories",
                subtitle: selectedKind == nil
                    ? "Your assistant learns and remembers things from your conversations. Memories will appear here as they're created."
                    : "Try selecting a different kind or clearing the filter.",
                icon: VIcon.bookOpen.rawValue
            )
        } else {
            ScrollView {
                LazyVStack(spacing: VSpacing.sm) {
                    ForEach(store.items) { item in
                        MemoryItemRow(
                            item: item,
                            onSelect: { withAnimation(VAnimation.panel) { selectedItem = item } },
                            onDelete: {
                                if selectedItem?.id == item.id {
                                    withAnimation(VAnimation.panel) { selectedItem = nil }
                                }
                                Task { _ = await store.deleteItem(id: item.id) }
                            }
                        )
                    }
                    if store.hasMore {
                        VLoadingIndicator()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, VSpacing.md)
                            .onAppear {
                                guard !store.isLoading else { return }
                                Task { await store.loadMore() }
                            }
                    }
                }
                .background { OverlayScrollerStyle() }
            }
            .scrollContentBackground(.hidden)
        }
    }
}

