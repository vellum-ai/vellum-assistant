#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Grid view of the user's local apps with 2-column layout.
struct AppsGridView: View {
    @ObservedObject var directoryStore: DirectoryStore
    @State private var appToDelete: AppItem?
    @State private var errorMessage: String?
    @State private var showShareSuccess = false
    @State private var bannerDismissTask: Task<Void, Never>?
    @AppStorage("pinnedAppIds") private var pinnedAppIdsData: Data = Data()
    @State private var pinnedAppIds: Set<String> = []

    private let columns = [
        GridItem(.flexible(), spacing: VSpacing.md),
        GridItem(.flexible(), spacing: VSpacing.md)
    ]

    // MARK: - Pinned App IDs

    private func decodePinnedIds(from data: Data) -> Set<String> {
        (try? JSONDecoder().decode(Set<String>.self, from: data)) ?? []
    }

    private func togglePin(for appId: String) {
        var ids = pinnedAppIds
        if ids.contains(appId) {
            ids.remove(appId)
        } else {
            ids.insert(appId)
        }
        pinnedAppIds = ids
        pinnedAppIdsData = (try? JSONEncoder().encode(ids)) ?? Data()
    }

    private func isPinned(_ appId: String) -> Bool {
        pinnedAppIds.contains(appId)
    }

    private var pinnedApps: [AppItem] {
        directoryStore.localApps.filter { isPinned($0.id) }
    }

    private var unpinnedApps: [AppItem] {
        directoryStore.localApps.filter { !isPinned($0.id) }
    }

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
        .alert("Error", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) { errorMessage = nil }
        } message: {
            if let msg = errorMessage {
                Text(msg)
            }
        }
        .overlay(alignment: .bottom) {
            if showShareSuccess {
                shareSuccessBanner
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .onAppear {
                        bannerDismissTask?.cancel()
                        bannerDismissTask = Task { @MainActor in
                            try? await Task.sleep(nanoseconds: 2_000_000_000)
                            guard !Task.isCancelled else { return }
                            withAnimation { showShareSuccess = false }
                        }
                    }
            }
        }
        .onDisappear {
            bannerDismissTask?.cancel()
            bannerDismissTask = nil
        }
        .onAppear {
            pinnedAppIds = decodePinnedIds(from: pinnedAppIdsData)
        }
        .onChange(of: pinnedAppIdsData) { _, newData in
            pinnedAppIds = decodePinnedIds(from: newData)
        }
    }

    // MARK: - Grid Content

    private var gridContent: some View {
        ScrollView {
            VStack(spacing: VSpacing.lg) {
                if !pinnedApps.isEmpty {
                    pinnedSection
                }
                allAppsSection
            }
            .padding(.vertical, VSpacing.sm)
        }
        .refreshable {
            directoryStore.fetchApps()
            while directoryStore.isLoadingApps {
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }
    }

    // MARK: - Pinned Section

    private var pinnedSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.xs) {
                VIconView(.pin, size: 14)
                    .foregroundColor(VColor.contentTertiary)
                Text("Pinned")
                    .font(VFont.labelDefault)
                    .foregroundColor(VColor.contentTertiary)
                    .textCase(.uppercase)
            }
            .padding(.horizontal, VSpacing.md)

            LazyVGrid(columns: columns, spacing: VSpacing.md) {
                ForEach(pinnedApps, id: \.id) { app in
                    appCard(app)
                }
            }
            .padding(.horizontal, VSpacing.md)
        }
    }

    // MARK: - All Apps Section

    private var allAppsSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            if !pinnedApps.isEmpty {
                Text("Other Apps")
                    .font(VFont.labelDefault)
                    .foregroundColor(VColor.contentTertiary)
                    .textCase(.uppercase)
                    .padding(.horizontal, VSpacing.md)
            }

            LazyVGrid(columns: columns, spacing: VSpacing.md) {
                ForEach(unpinnedApps, id: \.id) { app in
                    appCard(app)
                }
            }
            .padding(.horizontal, VSpacing.md)
        }
    }

    // MARK: - App Card

    private func appCard(_ app: AppItem) -> some View {
        Button {
            directoryStore.openApp(id: app.id)
        } label: {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                HStack {
                    Text(app.icon ?? "\u{1F4F1}")
                        .font(.system(size: 32))
                    Spacer()
                    if isPinned(app.id) {
                        VIconView(.pin, size: 12)
                            .foregroundColor(VColor.primaryBase)
                    }
                }

                Text(app.name)
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundColor(VColor.contentDefault)
                    .lineLimit(1)

                if let description = app.description {
                    Text(description)
                        .font(VFont.labelDefault)
                        .foregroundColor(VColor.contentSecondary)
                        .lineLimit(2)
                }

                Text(formattedDate(app.createdAt))
                    .font(VFont.labelDefault)
                    .foregroundColor(VColor.contentTertiary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(VSpacing.md)
            .background(VColor.surfaceBase)
            .cornerRadius(VRadius.lg)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(app.name)\(isPinned(app.id) ? ", pinned" : "")\(app.description != nil ? ", \(app.description!)" : "")")
        .accessibilityHint("Opens app. Long press for more options.")
        .contextMenu {
            Button {
                directoryStore.openApp(id: app.id)
            } label: {
                Label { Text("Open") } icon: { VIconView(.externalLink, size: 14) }
            }
            Button {
                togglePin(for: app.id)
            } label: {
                Label {
                    Text(isPinned(app.id) ? "Unpin" : "Pin")
                } icon: {
                    VIconView(isPinned(app.id) ? .pinOff : .pin, size: 14)
                }
            }
            Button {
                Task {
                    let success = await directoryStore.shareAppCloud(id: app.id)
                    if success {
                        withAnimation { showShareSuccess = true }
                    } else {
                        errorMessage = "Failed to share app. Please try again."
                    }
                }
            } label: {
                Label { Text("Share to Cloud") } icon: { VIconView(.upload, size: 14) }
            }
            Button {
                directoryStore.bundleApp(id: app.id)
            } label: {
                Label { Text("Bundle for Export") } icon: { VIconView(.package, size: 14) }
            }
            Divider()
            Button(role: .destructive) {
                appToDelete = app
            } label: {
                Label { Text("Delete") } icon: { VIconView(.trash, size: 14) }
            }
        }
    }

    // MARK: - Share Success Banner

    private var shareSuccessBanner: some View {
        HStack(spacing: VSpacing.sm) {
            VIconView(.circleCheck, size: 16)
                .foregroundColor(.white)
            Text("Shared to cloud")
                .font(VFont.bodyMediumEmphasised)
                .foregroundColor(.white)
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.sm)
        .background(VColor.primaryBase)
        .cornerRadius(VRadius.lg)
        .padding(.bottom, VSpacing.lg)
    }

    // MARK: - States

    private var loadingView: some View {
        VStack(spacing: VSpacing.md) {
            ProgressView()
            Text("Loading apps...")
                .font(VFont.bodyMediumLighter)
                .foregroundColor(VColor.contentSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var emptyView: some View {
        VStack(spacing: VSpacing.md) {
            VIconView(.layoutGrid, size: 48)
                .foregroundColor(VColor.contentTertiary)
                .accessibilityHidden(true)
            Text("No apps yet")
                .font(VFont.bodyMediumLighter)
                .foregroundColor(VColor.contentSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("No apps yet")
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
