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

    var icon: VIcon {
        switch self {
        case .newest: return .arrowDown
        case .oldest: return .arrowUp
        case .importance: return .star
        case .accessCount: return .eye
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
}

// MARK: - Memories Panel

struct MemoriesPanel: View {
    let connectionManager: GatewayConnectionManager
    @Binding var focusedMemoryId: String?
    @StateObject private var store: MemoryItemsStore
    @State private var showCreateSheet = false
    @State private var selectedItem: MemoryItemPayload?
    @State private var selectedKind: MemoryKind?
    @State private var statusFilter: MemoryStatusFilter = .active
    @State private var sortOption: MemorySortOption = .newest
    @State private var searchDebounceTask: Task<Void, Never>?
    @State private var showStatusFilterPopover = false
    @State private var showSortPopover = false

    init(connectionManager: GatewayConnectionManager, focusedMemoryId: Binding<String?> = .constant(nil)) {
        self.connectionManager = connectionManager
        _focusedMemoryId = focusedMemoryId
        _store = StateObject(wrappedValue: MemoryItemsStore(memoryItemClient: MemoryItemClient()))
    }

    /// Kinds to show in the sidebar filter. Excludes system-managed kinds.
    private static let filterableKinds: [MemoryKind] = [
        .identity, .preference, .project, .decision, .constraint, .event
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            filterBar
            HStack(alignment: .top, spacing: VSpacing.xxl) {
                kindSidebar
                    .frame(width: 220)
                contentView
            }
            .padding(.top, VSpacing.lg)
        }
        .task { await store.loadItems() }
        .task(id: focusedMemoryId) {
            guard let memoryId = focusedMemoryId else { return }
            if let item = await store.fetchDetail(id: memoryId) {
                withAnimation(VAnimation.fast) { selectedItem = item }
            }
            focusedMemoryId = nil
        }
        .onDisappear {
            searchDebounceTask?.cancel()
            searchDebounceTask = nil
        }
        .overlay {
            if let item = selectedItem {
                VColor.auxBlack.opacity(0.3)
                    .ignoresSafeArea()
                    .onTapGesture {
                        withAnimation(VAnimation.fast) { selectedItem = nil }
                    }

                MemoryItemDetailSheet(
                    item: item,
                    store: store,
                    onDismiss: {
                        withAnimation(VAnimation.fast) { selectedItem = nil }
                    }
                )
                .transition(.opacity.combined(with: .scale(scale: 0.97)))
            }
        }
        .animation(VAnimation.fast, value: selectedItem?.id)
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

            statusFilterDropdown
                .frame(width: 158)

            sortFilterDropdown
                .frame(width: 158)

            VButton(label: "New", icon: VIcon.plus.rawValue, style: .primary) {
                showCreateSheet = true
            }
            .accessibilityLabel("Create new memory")
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
        VSidebarRow(
            icon: icon,
            label: label,
            isActive: selectedKind == kind,
            action: {
                withAnimation(VAnimation.fast) { selectedKind = kind }
            }
        ) {
            Text("\(kindCount(for: kind))")
                .font(.custom("Inter", size: 11))
                .foregroundColor(VColor.contentTertiary)
        }
        .accessibilityLabel("\(label) filter")
        .accessibilityAddTraits(selectedKind == kind ? .isSelected : [])
    }

    private func kindCount(for kind: MemoryKind?) -> Int {
        guard let kind else { return store.items.count }
        return store.items.filter { $0.kind == kind.rawValue }.count
    }

    /// Items filtered by selected kind (client-side only — store always holds all items).
    private var filteredItems: [MemoryItemPayload] {
        guard let kind = selectedKind else { return store.items }
        return store.items.filter { $0.kind == kind.rawValue }
    }

    // MARK: - Status Filter Dropdown

    private var statusFilterDropdown: some View {
        Button {
            showStatusFilterPopover.toggle()
        } label: {
            HStack(spacing: VSpacing.md) {
                Text(statusFilter.rawValue)
                    .foregroundColor(VColor.contentDefault)
                    .font(VFont.body)
                    .frame(maxWidth: .infinity, alignment: .leading)

                VIconView(.chevronDown, size: 13)
                    .foregroundColor(VColor.contentTertiary)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)
            .frame(height: 32)
            .vInputChrome()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Status filter: \(statusFilter.rawValue)")
        .popover(isPresented: $showStatusFilterPopover, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(MemoryStatusFilter.allCases, id: \.self) { status in
                    Button {
                        statusFilter = status
                        store.statusFilter = status.apiValue
                        showStatusFilterPopover = false
                        Task { await store.loadItems() }
                    } label: {
                        HStack(spacing: VSpacing.sm) {
                            VIconView(status.icon, size: 14)
                                .foregroundColor(VColor.contentDefault)
                                .frame(width: 20)
                            Text(status.rawValue)
                                .font(VFont.body)
                                .foregroundColor(VColor.contentDefault)
                            Spacer()
                            if statusFilter == status {
                                VIconView(.check, size: 12)
                                    .foregroundColor(VColor.primaryBase)
                            }
                        }
                        .padding(.horizontal, VSpacing.md)
                        .padding(.vertical, VSpacing.sm)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(status.rawValue) status")
                    .accessibilityAddTraits(statusFilter == status ? .isSelected : [])
                }
            }
            .padding(.vertical, VSpacing.sm)
            .frame(width: 180)
        }
    }

    // MARK: - Sort Filter Dropdown

    private var sortFilterDropdown: some View {
        Button {
            showSortPopover.toggle()
        } label: {
            HStack(spacing: VSpacing.md) {
                Text(sortOption.rawValue)
                    .foregroundColor(VColor.contentDefault)
                    .font(VFont.body)
                    .frame(maxWidth: .infinity, alignment: .leading)

                VIconView(.chevronDown, size: 13)
                    .foregroundColor(VColor.contentTertiary)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)
            .frame(height: 32)
            .vInputChrome()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Sort by: \(sortOption.rawValue)")
        .popover(isPresented: $showSortPopover, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(MemorySortOption.allCases, id: \.self) { option in
                    Button {
                        sortOption = option
                        store.sortField = option.sortField
                        store.sortOrder = option.sortOrder
                        showSortPopover = false
                        Task { await store.loadItems() }
                    } label: {
                        HStack(spacing: VSpacing.sm) {
                            VIconView(option.icon, size: 14)
                                .foregroundColor(VColor.contentDefault)
                                .frame(width: 20)
                            Text(option.rawValue)
                                .font(VFont.body)
                                .foregroundColor(VColor.contentDefault)
                            Spacer()
                            if sortOption == option {
                                VIconView(.check, size: 12)
                                    .foregroundColor(VColor.primaryBase)
                            }
                        }
                        .padding(.horizontal, VSpacing.md)
                        .padding(.vertical, VSpacing.sm)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Sort by \(option.rawValue)")
                    .accessibilityAddTraits(sortOption == option ? .isSelected : [])
                }
            }
            .padding(.vertical, VSpacing.sm)
            .frame(width: 200)
        }
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
        } else if filteredItems.isEmpty {
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
                    ForEach(filteredItems) { item in
                        MemoryItemRow(
                            item: item,
                            onSelect: { withAnimation(VAnimation.fast) { selectedItem = item } },
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
