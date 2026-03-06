import SwiftUI
import VellumAssistantShared

/// Full-screen apps grid view showing all apps as a flat card grid with search.
struct AppsGridView: View {
    @ObservedObject var appListManager: AppListManager
    let daemonClient: DaemonClient
    let onOpenApp: (String) -> Void

    @State private var searchText = ""
    @State private var hoveredAppId: String?
    @State private var editingApp: AppListManager.AppItem?
    @State private var sharingAppId: String?
    @State private var shareFileURL: URL?
    @State private var shareAppName: String = ""
    @State private var shareAppIcon: NSImage?
    @State private var showShareSheet = false
    @State private var isBundling = false

    /// Cache of lazily-loaded preview screenshots keyed by app ID.
    /// Empty string is used as a sentinel for "fetched but no preview available".
    @State private var previewCache: [String: String] = [:]
    /// In-flight preview fetch tasks, keyed by app ID, so they can be cancelled.
    @State private var previewTasks: [String: Task<Void, Never>] = [:]

    private let columns = Array(repeating: GridItem(.flexible(), spacing: VSpacing.xl), count: 5)

    /// Maximum width of the centered content area.
    private let maxContentWidth: CGFloat = 1400

    var body: some View {
        Group {
            if appListManager.apps.isEmpty {
                noAppsEmptyState
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    // Header
                    HStack(alignment: .center) {
                        Text("Things")
                            .font(VFont.panelTitle)
                            .foregroundColor(VColor.textPrimary)
                        Spacer()
                    }
                    .padding(.bottom, VSpacing.md)

                    Divider().background(VColor.surfaceBorder)

                    ScrollView {
                        VStack(spacing: VSpacing.xxl) {
                            searchBar

                            let pinned = filteredPinnedApps
                            let recents = filteredRecentApps

                            if !pinned.isEmpty {
                                appSection(title: "Pinned", apps: pinned)
                            }

                            if !recents.isEmpty {
                                appSection(title: "Recents", apps: recents)
                            }

                            if pinned.isEmpty && recents.isEmpty && !searchText.isEmpty {
                                VEmptyState(
                                    title: "No apps matched",
                                    subtitle: "No apps matched \"\(searchText)\"",
                                    icon: "magnifyingglass"
                                )
                                .frame(maxWidth: .infinity)
                                .padding(.top, VSpacing.xxxl)
                            }
                        }
                        .frame(maxWidth: maxContentWidth)
                        .frame(maxWidth: .infinity)
                        .padding(.top, VSpacing.lg)
                    }
                }
                .padding(VSpacing.xl)
            }
        }
        .background(VColor.backgroundSubtle)
        .onDisappear {
            for task in previewTasks.values { task.cancel() }
            previewTasks.removeAll()
        }
        .sheet(item: $editingApp) { app in
            AppIconPickerSheet(
                appName: app.name,
                currentSymbol: resolvedIcon(for: app),
                onSave: { symbol in
                    appListManager.updateAppIcon(id: app.id, sfSymbol: symbol)
                }
            )
        }
    }

    // MARK: - Empty State

    private var noAppsEmptyState: some View {
        VStack(spacing: VSpacing.xl) {
            Image(systemName: "square.grid.2x2")
                .font(.system(size: 40, weight: .thin))
                .foregroundColor(VColor.textMuted)

            VStack(spacing: VSpacing.sm) {
                Text("No things yet")
                    .font(VFont.bodyBold)
                    .foregroundColor(VColor.textSecondary)

                Text("Ask the assistant to build something")
                    .font(VFont.body)
                    .foregroundColor(VColor.textMuted)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Search Bar

    private var searchBar: some View {
        VSearchBar(placeholder: "Find your things", text: $searchText)
    }

    // MARK: - App Card

    private func appCard(_ app: AppListManager.AppItem) -> some View {
        let isHovered = hoveredAppId == app.id
        let iconSymbol = resolvedIcon(for: app)
        let rawPreview = app.previewBase64 ?? previewCache[app.id]
        let preview = rawPreview?.isEmpty == true ? nil : rawPreview

        return Button {
            appListManager.recordAppOpen(
                id: app.id, name: app.name, icon: app.icon,
                previewBase64: app.previewBase64, appType: app.appType
            )
            onOpenApp(app.id)
        } label: {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                // Preview thumbnail or icon placeholder — all corners rounded.
                // Use a sized container with .overlay so .fill images don't overflow.
                Group {
                    if let nsImage = AppPreviewImageStore.image(appId: app.id, base64: preview) {
                        Color.clear
                            .aspectRatio(16.0 / 10.0, contentMode: .fit)
                            .overlay(
                                Image(nsImage: nsImage)
                                    .resizable()
                                    .aspectRatio(contentMode: .fill)
                            )
                            .clipped()
                    } else {
                        ZStack {
                            Moss._100

                            Image(systemName: iconSymbol)
                                .font(.system(size: 32, weight: .medium))
                                .foregroundColor(VColor.textMuted)
                        }
                        .aspectRatio(16.0 / 10.0, contentMode: .fit)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.surfaceBorder, lineWidth: 1)
                )
                .overlay(alignment: .topTrailing) {
                    ZStack {
                        AppSharePanel(
                            items: shareFileURL != nil && sharingAppId == app.id ? [shareFileURL!] : [],
                            isPresented: Binding(
                                get: { showShareSheet && sharingAppId == app.id },
                                set: { newValue in
                                    showShareSheet = newValue
                                    if !newValue { sharingAppId = nil }
                                }
                            ),
                            appName: shareAppName,
                            appIcon: shareAppIcon
                        )
                        .frame(width: 0, height: 0)
                        .opacity(0)

                        VIconButton(label: "App actions", icon: "ellipsis", iconOnly: true, variant: .filled(VColor.buttonPrimary), size: 24) {}
                            .allowsHitTesting(false)
                        Menu {
                            Button {
                                if app.isPinned {
                                    appListManager.unpinApp(id: app.id)
                                } else {
                                    appListManager.pinApp(id: app.id)
                                }
                            } label: {
                                Label(app.isPinned ? "Unpin" : "Pin", systemImage: app.isPinned ? "pin.slash" : "pin")
                            }
                            Button {
                                bundleAndShareLocal(appId: app.id)
                            } label: {
                                Label("Share", systemImage: "square.and.arrow.up")
                            }
                            Button {
                                editingApp = app
                            } label: {
                                Label("Change Icon", systemImage: "paintbrush")
                            }
                            Button(role: .destructive) {
                                if hoveredAppId != nil {
                                    hoveredAppId = nil
                                    NSCursor.pop()
                                }
                                try? daemonClient.sendAppDelete(appId: app.id)
                                appListManager.removeApp(id: app.id)
                                AppPreviewImageStore.remove(appId: app.id)
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        } label: {
                            Color.clear
                                .contentShape(Rectangle())
                                .frame(width: 32, height: 32)
                        }
                        .menuStyle(.borderlessButton)
                        .menuIndicator(.hidden)
                    }
                    .fixedSize()
                    .accessibilityLabel("App actions")
                    .padding(VSpacing.sm)
                    .contentShape(Rectangle())
                    .onTapGesture {} // absorb tap so it doesn't propagate to parent Button
                    .opacity(isHovered ? 1 : 0)
                    .allowsHitTesting(isHovered)
                    .animation(VAnimation.fast, value: isHovered)
                }


                // Name + date below the image
                VStack(alignment: .leading, spacing: 2) {
                    Text(app.name)
                        .font(VFont.bodyBold)
                        .foregroundColor(VColor.textPrimary)
                        .lineLimit(1)

                    Text(Self.formatDate(app.lastOpenedAt))
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                        .lineLimit(1)
                }
                .padding(.horizontal, VSpacing.xs)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            hoveredAppId = hovering ? app.id : nil
            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
        .contextMenu {
            Button("Open") {
                appListManager.recordAppOpen(
                    id: app.id, name: app.name, icon: app.icon,
                    previewBase64: app.previewBase64, appType: app.appType
                )
                onOpenApp(app.id)
            }
            Button(app.isPinned ? "Unpin" : "Pin") {
                if app.isPinned {
                    appListManager.unpinApp(id: app.id)
                } else {
                    appListManager.pinApp(id: app.id)
                }
            }
            Button("Share") {
                bundleAndShareLocal(appId: app.id)
            }
            Button("Change Icon") {
                editingApp = app
            }
        }
        .accessibilityLabel(app.name)
    }

    // MARK: - Sharing

    private func bundleAndShareLocal(appId: String) {
        guard !isBundling else { return }
        isBundling = true
        sharingAppId = appId

        let previousHandler = daemonClient.onBundleAppResponse
        daemonClient.onBundleAppResponse = { response in
            daemonClient.onBundleAppResponse = previousHandler
            let url = MainWindowView.cleanBundleURL(bundlePath: response.bundlePath, appName: response.manifest.name)
            MainWindowView.applyFileIcon(to: url, iconBase64: response.iconImageBase64, emojiIcon: response.manifest.icon, appName: response.manifest.name)
            shareFileURL = url
            shareAppName = response.manifest.name
            shareAppIcon = MainWindowView.buildAppIcon(iconBase64: response.iconImageBase64, emojiIcon: response.manifest.icon, appName: response.manifest.name)
            isBundling = false
            showShareSheet = true
        }

        do {
            try daemonClient.sendBundleApp(appId: appId)
        } catch {
            isBundling = false
            sharingAppId = nil
            daemonClient.onBundleAppResponse = previousHandler
        }
    }

    // MARK: - Preview Fetching

    private func fetchPreviewIfNeeded(_ app: AppListManager.AppItem) {
        // Skip if the app already has an inline preview
        guard app.previewBase64 == nil else { return }
        // Skip if already cached (including empty-string sentinel) or in-flight
        guard previewCache[app.id] == nil, previewTasks[app.id] == nil else { return }

        let stream = daemonClient.subscribe()
        do {
            try daemonClient.sendAppPreview(appId: app.id)
        } catch { return }

        let appId = app.id
        let task = Task { @MainActor in
            let timeout = Task { try await Task.sleep(nanoseconds: 10_000_000_000) }
            defer {
                timeout.cancel()
                self.previewTasks.removeValue(forKey: appId)
            }

            for await message in stream {
                if Task.isCancelled { break }
                if case .appPreviewResponse(let response) = message,
                   response.appId == appId {
                    self.previewCache[appId] = response.preview ?? ""
                    return
                }
            }
        }

        Task {
            try? await Task.sleep(nanoseconds: 10_000_000_000)
            if !task.isCancelled { task.cancel() }
        }

        previewTasks[appId] = task
    }

    // MARK: - Sections

    private func appSection(title: String, apps: [AppListManager.AppItem]) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text(title)
                .font(VFont.headline)
                .foregroundColor(VColor.textSecondary)

            LazyVGrid(columns: columns, spacing: VSpacing.xxl) {
                ForEach(apps) { app in
                    appCard(app)
                        .onAppear { fetchPreviewIfNeeded(app) }
                }
            }
        }
    }

    // MARK: - Helpers

    private func resolvedIcon(for app: AppListManager.AppItem) -> String {
        if let symbol = app.sfSymbol {
            return symbol
        }
        return VAppIconGenerator.generate(from: app.name, type: app.appType)
    }

    /// Pinned apps filtered by search text.
    private var filteredPinnedApps: [AppListManager.AppItem] {
        let pinned = appListManager.pinnedApps
        guard !searchText.isEmpty else { return pinned }
        return pinned.filter { matchesSearch($0) }
    }

    /// Unpinned apps sorted by lastOpenedAt descending, filtered by search text.
    private var filteredRecentApps: [AppListManager.AppItem] {
        let unpinned = appListManager.displayApps.filter { !$0.isPinned }
        guard !searchText.isEmpty else { return unpinned }
        return unpinned.filter { matchesSearch($0) }
    }

    private func matchesSearch(_ app: AppListManager.AppItem) -> Bool {
        app.name.localizedCaseInsensitiveContains(searchText) ||
        (app.description?.localizedCaseInsensitiveContains(searchText) ?? false)
    }

    /// Formats a date in a locale-aware medium style (e.g. "Jan 12, 2026" in en_US).
    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter
    }()

    private static func formatDate(_ date: Date) -> String {
        dateFormatter.string(from: date)
    }
}

// MARK: - Preview

struct AppsGridView_Previews: PreviewProvider {
    struct PreviewWrapper: View {
        @StateObject private var appListManager = AppListManager()

        var body: some View {
            AppsGridView(
                appListManager: appListManager,
                daemonClient: DaemonClient(),
                onOpenApp: { _ in }
            )
            .onAppear {
                appListManager.recordAppOpen(id: "1", name: "Weather", icon: nil, appType: "app")
                appListManager.recordAppOpen(id: "2", name: "Notes", icon: nil, appType: "app")
                appListManager.recordAppOpen(id: "3", name: "Calendar", icon: nil, appType: "app")
                appListManager.recordAppOpen(id: "4", name: "Music", icon: nil, appType: "app")
                appListManager.recordAppOpen(id: "5", name: "Photos", icon: nil, appType: "site")
                appListManager.recordAppOpen(id: "6", name: "Maps", icon: nil, appType: "app")
                appListManager.pinApp(id: "1")
                appListManager.pinApp(id: "2")
            }
        }
    }

    static var previews: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            PreviewWrapper()
        }
        .frame(width: 800, height: 600)
    }
}
