#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Searchable list of documents with sort options.
struct DocumentsListView: View {
    @ObservedObject var directoryStore: DirectoryStore
    @State private var searchText = ""
    @State private var sortOrder: SortOrder = .byDate

    private enum SortOrder: String, CaseIterable {
        case byDate = "Date"
        case byTitle = "Title"
    }

    private var filteredDocuments: [DocumentListItem] {
        let filtered: [DocumentListItem]
        if searchText.isEmpty {
            filtered = directoryStore.documents
        } else {
            filtered = directoryStore.documents.filter {
                $0.title.localizedCaseInsensitiveContains(searchText)
            }
        }

        switch sortOrder {
        case .byDate:
            return filtered.sorted { $0.updatedAt > $1.updatedAt }
        case .byTitle:
            return filtered.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
        }
    }

    var body: some View {
        Group {
            if directoryStore.isLoadingDocuments && directoryStore.documents.isEmpty {
                loadingView
            } else if directoryStore.documents.isEmpty {
                emptyView
            } else {
                listContent
            }
        }
    }

    // MARK: - List Content

    private var listContent: some View {
        List(filteredDocuments) { doc in
            Button {
                directoryStore.loadDocument(surfaceId: doc.id)
            } label: {
                documentRow(doc)
            }
        }
        .listStyle(.plain)
        .searchable(text: $searchText, prompt: "Search documents")
        .refreshable {
            directoryStore.fetchDocuments()
            while directoryStore.isLoadingDocuments {
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    ForEach(SortOrder.allCases, id: \.self) { order in
                        Button {
                            sortOrder = order
                        } label: {
                            HStack {
                                Text("Sort by \(order.rawValue)")
                                if sortOrder == order {
                                    VIconView(.check, size: 12)
                                }
                            }
                        }
                    }
                } label: {
                    VIconView(.arrowDown, size: 14)
                }
                .accessibilityLabel("Sort documents")
            }
        }
    }

    // MARK: - Row

    private func documentRow(_ doc: DocumentListItem) -> some View {
        HStack(spacing: VSpacing.md) {
            VIconView(.fileText, size: 24)
                .foregroundStyle(VColor.contentTertiary)

            VStack(alignment: .leading, spacing: 2) {
                Text(doc.title)
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)

                HStack(spacing: VSpacing.sm) {
                    Text("\(doc.wordCount) words")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)

                    Text(formattedDate(doc.updatedAt))
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
            }

            Spacer()
        }
        .padding(.vertical, VSpacing.xs)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(doc.title), \(doc.wordCount) words, updated \(formattedDate(doc.updatedAt))")
        .accessibilityHint("Opens document")
    }

    // MARK: - States

    private var loadingView: some View {
        VStack(spacing: VSpacing.md) {
            ProgressView()
            Text("Loading documents...")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyView: some View {
        VStack(spacing: VSpacing.md) {
            VIconView(.fileText, size: 48)
                .foregroundStyle(VColor.contentTertiary)
                .accessibilityHidden(true)
            Text("No documents yet")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("No documents yet")
    }

    // MARK: - Helpers

    private func formattedDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter.string(from: date)
    }
}
#endif
