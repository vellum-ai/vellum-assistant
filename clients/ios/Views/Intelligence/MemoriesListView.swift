#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct MemoriesListView: View {
    @ObservedObject var store: MemoryItemsStore
    @State private var searchText = ""
    @State private var selectedKind: String? = nil
    @State private var showCreateSheet = false

    var body: some View {
        Group {
            if store.isLoading && store.items.isEmpty {
                loadingState
            } else if store.items.isEmpty {
                emptyState
            } else {
                memoriesList
            }
        }
        .searchable(text: $searchText, prompt: "Search memories...")
        .onChange(of: searchText) { _, newValue in
            store.searchText = newValue
            Task { await store.loadItems() }
        }
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

    // MARK: - Memories List

    private var memoriesList: some View {
        List {
            // Kind filter chips
            Section {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: VSpacing.sm) {
                        kindFilterChip("All", kind: nil)
                        ForEach(MemoryKind.allCases) { kind in
                            kindFilterChip(kind.label, kind: kind.rawValue)
                        }
                    }
                }
            }

            // Memory items
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
                .font(VFont.caption)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(
                    Capsule()
                        .fill(isSelected ? VColor.primaryBase : VColor.surfaceActive)
                )
                .foregroundColor(isSelected ? .white : VColor.contentSecondary)
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
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.contentDefault)
                    .lineLimit(1)

                Text(item.statement)
                    .font(VFont.body)
                    .foregroundColor(VColor.contentSecondary)
                    .lineLimit(2)
            }

            Spacer()

            Text(item.relativeLastSeen)
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
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
                .foregroundColor(VColor.contentTertiary)
                .accessibilityHidden(true)

            Text("No Memories Yet")
                .font(VFont.title)
                .foregroundColor(VColor.contentDefault)

            Text("Your assistant learns from conversations.")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
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
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
#endif
