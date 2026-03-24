#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

private enum MemoryStatusFilter: String, CaseIterable {
    case active = "Active"
    case inactive = "Inactive"
    case all = "All"

    /// API value sent as the `status` query parameter.
    /// "all" is a sentinel that tells the server to skip status filtering.
    var apiValue: String {
        switch self {
        case .active: return "active"
        case .inactive: return "inactive"
        case .all: return "all"
        }
    }
}

struct MemoriesListView: View {
    @ObservedObject var store: MemoryItemsStore
    @State private var searchText = ""
    @State private var selectedKind: String? = nil
    @State private var statusFilter: MemoryStatusFilter = .active
    @State private var showCreateSheet = false
    @State private var searchDebounceTask: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 0) {
            filterBar
            Group {
                if store.isLoading && store.items.isEmpty {
                    loadingState
                } else if store.items.isEmpty {
                    emptyState
                } else {
                    memoriesList
                }
            }
        }
        .searchable(text: $searchText, prompt: "Search memories...")
        .onChange(of: searchText) { _, newValue in
            store.searchText = newValue
            searchDebounceTask?.cancel()
            searchDebounceTask = Task {
                try? await Task.sleep(nanoseconds: 300_000_000)
                guard !Task.isCancelled else { return }
                await store.loadItems()
            }
        }
        .onDisappear { searchDebounceTask?.cancel() }
        .navigationTitle("Memories")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showCreateSheet = true
                } label: {
                    VIconView(.plus, size: 16)
                }
            }
        }
        .refreshable { await store.loadItems() }
        .task { await store.loadItems() }
        .sheet(isPresented: $showCreateSheet) {
            NavigationStack {
                MemoryItemCreateView(store: store)
            }
        }
    }

    // MARK: - Filter Bar

    private var filterBar: some View {
        VStack(spacing: VSpacing.sm) {
            Picker("Status", selection: $statusFilter) {
                ForEach(MemoryStatusFilter.allCases, id: \.self) { filter in
                    Text(filter.rawValue).tag(filter)
                }
            }
            .pickerStyle(.segmented)
            .onChange(of: statusFilter) { _, newValue in
                store.statusFilter = newValue.apiValue
                Task { await store.loadItems() }
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: VSpacing.sm) {
                    kindFilterChip("All", kind: nil)
                    ForEach(MemoryKind.allCases) { kind in
                        kindFilterChip(kind.label, kind: kind.rawValue)
                    }
                }
            }
        }
        .padding(.horizontal)
        .padding(.vertical, VSpacing.sm)
    }

    // MARK: - Memories List

    private var memoriesList: some View {
        List {
            Section {
                ForEach(store.items) { item in
                    NavigationLink {
                        MemoryItemDetailView(item: item, store: store)
                    } label: {
                        memoryRow(item)
                    }
                }
            }
        }
    }

    // MARK: - Kind Filter Chip

    private func kindFilterChip(_ label: String, kind: String?) -> some View {
        let isSelected = selectedKind == kind
        return Button {
            selectedKind = kind
            store.kindFilter = kind
            Task { await store.loadItems() }
        } label: {
            Text(label)
                .font(VFont.labelDefault)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(
                    Capsule()
                        .fill(isSelected ? VColor.primaryBase : VColor.surfaceActive)
                )
                .foregroundStyle(isSelected ? .white : VColor.contentSecondary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(label) filter\(isSelected ? ", selected" : "")")
    }

    // MARK: - Memory Row

    private func memoryRow(_ item: MemoryItemPayload) -> some View {
        HStack(spacing: VSpacing.sm) {
            // Kind color indicator
            Circle()
                .fill(MemoryKind(rawValue: item.kind)?.color ?? VColor.contentTertiary)
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(item.subject)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)

                Text(item.statement)
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)
                    .lineLimit(2)
            }

            Spacer()

            Text(item.relativeLastSeen)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
        .padding(.vertical, 2)
        .swipeActions(edge: .trailing) {
            Button("Delete", role: .destructive) {
                Task { await store.deleteItem(id: item.id) }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Memory: \(item.subject). \(item.statement). \(item.relativeLastSeen)")
    }

    // MARK: - Empty States

    private var emptyState: some View {
        VStack(spacing: VSpacing.lg) {
            VIconView(.bookOpen, size: 48)
                .foregroundStyle(VColor.contentTertiary)
                .accessibilityHidden(true)

            Text("No Memories Yet")
                .font(VFont.titleMedium)
                .foregroundStyle(VColor.contentDefault)

            Text("Your assistant learns from conversations.")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("No memories yet. Your assistant learns from conversations.")
    }

    private var loadingState: some View {
        VStack(spacing: VSpacing.md) {
            ProgressView()
            Text("Loading memories...")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
#endif
