import AppKit
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
}

// MARK: - Memories Panel

struct MemoriesPanel: View {
    let connectionManager: GatewayConnectionManager
    @Binding var focusedMemoryId: String?
    @State private var store: MemoryItemsStore
    @State private var showCreateSheet = false
    @State private var selectedItem: MemoryItemPayload?
    @State private var selectedKind: MemoryKind?
    @State private var statusFilter: MemoryStatusFilter = .active
    @State private var sortOption: MemorySortOption = .newest
    @State private var searchDebounceTask: Task<Void, Never>?
    @State private var escapeMonitor: Any?

    init(connectionManager: GatewayConnectionManager, focusedMemoryId: Binding<String?> = .constant(nil)) {
        self.connectionManager = connectionManager
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
                ZStack {
                    VColor.auxBlack.opacity(0.4)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            withAnimation(VAnimation.fast) { selectedItem = nil }
                        }
                    MemoryItemDetailSheet(
                        item: item,
                        store: store,
                        onDismiss: { withAnimation(VAnimation.fast) { selectedItem = nil } }
                    )
                    .id(selectedItem?.id)
                }
                .transition(.opacity)
                .onAppear { installEscapeMonitor() }
                .onDisappear { removeEscapeMonitor() }
            }
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
                options: MemoryStatusFilter.allCases.map { VDropdownOption(label: $0.rawValue, value: $0, icon: $0.icon) },
                selection: $statusFilter,
                maxWidth: 158,
                onChange: { newStatus in
                    store.statusFilter = newStatus.apiValue
                    Task { await store.loadItems() }
                }
            )

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

    // MARK: - Escape Key

    private func installEscapeMonitor() {
        escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard event.keyCode == 53 else { return event } // 53 = Escape
            withAnimation(VAnimation.fast) { selectedItem = nil }
            return nil
        }
    }

    private func removeEscapeMonitor() {
        if let monitor = escapeMonitor {
            NSEvent.removeMonitor(monitor)
            escapeMonitor = nil
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
                            onSelect: { withAnimation(VAnimation.fast) { selectedItem = item } },
                            onDelete: {
                                Task { _ = await store.deleteItem(id: item.id) }
                            }
                        )
                    }
                    if store.hasMore {
                        VLoadingIndicator()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, VSpacing.md)
                            .onAppear {
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
