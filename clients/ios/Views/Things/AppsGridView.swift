#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Grid view of the user's local apps with 2-column layout.
struct AppsGridView: View {
    @ObservedObject var directoryStore: DirectoryStore
    @State private var appToDelete: AppItem?

    private let columns = [
        GridItem(.flexible(), spacing: VSpacing.md),
        GridItem(.flexible(), spacing: VSpacing.md)
    ]

    var body: some View {
        Group {
            if directoryStore.isLoadingApps && directoryStore.localApps.isEmpty {
                loadingView
            } else if directoryStore.localApps.isEmpty {
                emptyView
            } else {
                gridContent
            }
        }
        .alert("Delete App", isPresented: Binding(
            get: { appToDelete != nil },
            set: { if !$0 { appToDelete = nil } }
        )) {
            Button("Cancel", role: .cancel) { appToDelete = nil }
            Button("Delete", role: .destructive) {
                if let app = appToDelete {
                    directoryStore.deleteApp(id: app.id)
                    appToDelete = nil
                }
            }
        } message: {
            if let app = appToDelete {
                Text("Are you sure you want to delete \"\(app.name)\"? This action cannot be undone.")
            }
        }
    }

    // MARK: - Grid Content

    private var gridContent: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: VSpacing.md) {
                ForEach(directoryStore.localApps, id: \.id) { app in
                    appCard(app)
                }
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
        }
        .refreshable {
            directoryStore.fetchApps()
            // fetchApps() fires an internal Task; await loading completion
            // so the pull-to-refresh spinner stays visible until data arrives.
            while directoryStore.isLoadingApps {
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }
    }

    // MARK: - App Card

    private func appCard(_ app: AppItem) -> some View {
        Button {
            directoryStore.openApp(id: app.id)
        } label: {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text(app.icon ?? "\u{1F4F1}")
                    .font(.system(size: 32))

                Text(app.name)
                    .font(VFont.bodyBold)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(1)

                if let description = app.description {
                    Text(description)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                        .lineLimit(2)
                }

                Text(formattedDate(app.createdAt))
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(VSpacing.md)
            .background(VColor.surface)
            .cornerRadius(VRadius.lg)
        }
        .contextMenu {
            Button {
                directoryStore.openApp(id: app.id)
            } label: {
                Label { Text("Open") } icon: { VIconView(.externalLink, size: 14) }
            }
            Button {
                directoryStore.shareAppCloud(id: app.id)
            } label: {
                Label { Text("Share") } icon: { VIconView(.share, size: 14) }
            }
            Divider()
            Button(role: .destructive) {
                appToDelete = app
            } label: {
                Label { Text("Delete") } icon: { VIconView(.trash, size: 14) }
            }
        }
    }

    // MARK: - States

    private var loadingView: some View {
        VStack(spacing: VSpacing.md) {
            ProgressView()
            Text("Loading apps...")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyView: some View {
        VStack(spacing: VSpacing.md) {
            VIconView(.layoutGrid, size: 48)
                .foregroundColor(VColor.textMuted)
            Text("No apps yet")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Helpers

    private func formattedDate(_ timestamp: Int) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(timestamp) / 1000.0)
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter.string(from: date)
    }
}
#endif
