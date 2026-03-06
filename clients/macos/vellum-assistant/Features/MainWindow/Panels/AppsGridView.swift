import SwiftUI
import VellumAssistantShared

/// Full-screen apps grid view showing all apps as a flat card grid with search.
struct AppsGridView: View {
    @ObservedObject var appListManager: AppListManager
    let daemonClient: DaemonClient
    let gatewayBaseURL: String
    let onOpenApp: (String) -> Void
    /// Called when the user opens a shared app (needs surface-based navigation).
    var onOpenSharedApp: ((UiSurfaceShowMessage) -> Void)?

    private enum Tab: String, CaseIterable {
        case recents = "Recents"
        case all = "All"
        case shared = "Shared"
    }

    @State private var selectedTab: Tab = .recents
    @State private var searchText = ""
    @State private var hoveredAppId: String?
    @State private var editingApp: AppListManager.AppItem?
    @State private var sharingAppId: String?
    @State private var shareFileURL: URL?
    @State private var shareAppName: String = ""
    @State private var shareAppIcon: NSImage?
    @State private var showShareSheet = false
    @State private var isBundling = false

    // Daemon-fetched data for "All" and "Shared" tabs
    @State private var allLocalApps: [AppItem] = []
    @State private var sharedApps: [SharedAppItem] = []
    @State private var isLoadingAll = false
    @State private var isLoadingShared = false
    @State private var hasFetchedAll = false
    @State private var hasFetchedShared = false

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
            if appListManager.apps.isEmpty && allLocalApps.isEmpty && sharedApps.isEmpty && selectedTab == .recents {
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

                    VSegmentedControl(
                        items: Tab.allCases.map { (label: $0.rawValue, tag: $0) },
                        selection: $selectedTab
                    )
                    .padding(.bottom, VSpacing.sm)

                    Divider().background(VColor.surfaceBorder)

                    switch selectedTab {
                    case .recents:
                        recentsContent
                    case .all:
                        allContent
                    case .shared:
                        sharedContent
                    }
                }
                .padding(VSpacing.xl)
            }
        }
        .background(VColor.backgroundSubtle)
        .onChange(of: selectedTab) { _, newTab in
            if newTab == .all && !hasFetchedAll { fetchAllApps() }
            if newTab == .shared && !hasFetchedShared { fetchSharedApps() }
        }
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

    // MARK: - Tab Content

    private var recentsContent: some View {
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
                        icon: VIcon.search.rawValue
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

    private var allContent: some View {
        ScrollView {
            VStack(spacing: VSpacing.xxl) {
                searchBar

                if isLoadingAll {
                    ProgressView()
                        .controlSize(.regular)
                        .frame(maxWidth: .infinity)
                        .padding(.top, VSpacing.xxxl)
                } else if filteredAllApps.isEmpty && !searchText.isEmpty {
                    VEmptyState(
                        title: "No apps matched",
                        subtitle: "No apps matched \"\(searchText)\"",
                        icon: VIcon.search.rawValue
                    )
                    .frame(maxWidth: .infinity)
                    .padding(.top, VSpacing.xxxl)
                } else if allLocalApps.isEmpty {
                    VEmptyState(
                        title: "No apps yet",
                        subtitle: "Ask the assistant to build something",
                        icon: "square.grid.2x2"
                    )
                    .frame(maxWidth: .infinity)
                    .padding(.top, VSpacing.xxxl)
                } else {
                    allAppsGrid
                }
            }
            .frame(maxWidth: maxContentWidth)
            .frame(maxWidth: .infinity)
            .padding(.top, VSpacing.lg)
        }
    }

    private var sharedContent: some View {
        ScrollView {
            VStack(spacing: VSpacing.xxl) {
                searchBar

                if isLoadingShared {
                    ProgressView()
                        .controlSize(.regular)
                        .frame(maxWidth: .infinity)
                        .padding(.top, VSpacing.xxxl)
                } else if filteredSharedApps.isEmpty && !searchText.isEmpty {
                    VEmptyState(
                        title: "No apps matched",
                        subtitle: "No apps matched \"\(searchText)\"",
                        icon: VIcon.search.rawValue
                    )
                    .frame(maxWidth: .infinity)
                    .padding(.top, VSpacing.xxxl)
                } else if sharedApps.isEmpty {
                    VEmptyState(
                        title: "No shared apps",
                        subtitle: "Apps shared with you will appear here",
                        icon: "person.2"
                    )
                    .frame(maxWidth: .infinity)
                    .padding(.top, VSpacing.xxxl)
                } else {
                    sharedAppsGrid
                }
            }
            .frame(maxWidth: maxContentWidth)
            .frame(maxWidth: .infinity)
            .padding(.top, VSpacing.lg)
        }
    }

    // MARK: - Empty State

    private var noAppsEmptyState: some View {
        VStack(spacing: VSpacing.xl) {
            VIconView(.layoutGrid, size: 40)
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
                        if isBundling && sharingAppId == app.id {
                            ProgressView()
                                .controlSize(.small)
                                .frame(width: 24, height: 24)
                        } else {
                            VIconButton(label: "App actions", icon: VIcon.ellipsis.rawValue, iconOnly: true, variant: .primary, size: 24) {}
                                .allowsHitTesting(false)
                        }
                        Menu {
                            Button {
                                if app.isPinned {
                                    appListManager.unpinApp(id: app.id)
                                } else {
                                    appListManager.pinApp(id: app.id)
                                }
                            } label: {
                                Label { Text(app.isPinned ? "Unpin" : "Pin") } icon: { VIconView(app.isPinned ? .pinOff : .pin, size: 14) }
                            }
                            Button {
                                bundleAndShareLocal(appId: app.id)
                            } label: {
                                Label { Text("Share") } icon: { VIconView(.share, size: 14) }
                            }
                            Button {
                                editingApp = app
                            } label: {
                                Label { Text("Change Icon") } icon: { VIconView(.paintbrush, size: 14) }
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
                                Label { Text("Delete") } icon: { VIconView(.trash, size: 14) }
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
                    .opacity(isHovered || (isBundling && sharingAppId == app.id) ? 1 : 0)
                    .allowsHitTesting(isHovered || (isBundling && sharingAppId == app.id))
                    .animation(VAnimation.fast, value: isHovered)
                    .overlay {
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
                            appIcon: shareAppIcon,
                            appId: sharingAppId == app.id ? app.id : nil,
                            gatewayBaseURL: gatewayBaseURL
                        )
                        .allowsHitTesting(false)
                    }
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

    // MARK: - All Apps Grid

    private var allAppsGrid: some View {
        LazyVGrid(columns: columns, spacing: VSpacing.xxl) {
            ForEach(filteredAllApps) { app in
                allAppCard(app)
            }
        }
    }

    private func allAppCard(_ app: AppItem) -> some View {
        let preview = previewCache[app.id]
        let resolvedPreview = preview?.isEmpty == true ? nil : preview

        return Button {
            appListManager.recordAppOpen(
                id: app.id, name: app.name, icon: app.icon,
                appType: nil
            )
            onOpenApp(app.id)
        } label: {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Group {
                    if let nsImage = AppPreviewImageStore.image(appId: app.id, base64: resolvedPreview) {
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

                            if let icon = app.icon {
                                Text(icon)
                                    .font(.system(size: 32))
                            } else {
                                Image(systemName: VAppIconGenerator.generate(from: app.name, type: nil))
                                    .font(.system(size: 32, weight: .medium))
                                    .foregroundColor(VColor.textMuted)
                            }
                        }
                        .aspectRatio(16.0 / 10.0, contentMode: .fit)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.surfaceBorder, lineWidth: 1)
                )

                VStack(alignment: .leading, spacing: 2) {
                    Text(app.name)
                        .font(VFont.bodyBold)
                        .foregroundColor(VColor.textPrimary)
                        .lineLimit(1)

                    Text(Self.formatEpochMs(app.createdAt))
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
            hoveredAppId = hovering ? "all-\(app.id)" : nil
            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
        .onAppear { fetchPreviewForAllApp(app) }
    }

    // MARK: - Shared Apps Grid

    private var sharedAppsGrid: some View {
        LazyVGrid(columns: columns, spacing: VSpacing.xxl) {
            ForEach(filteredSharedApps) { app in
                sharedAppCard(app)
            }
        }
    }

    private func sharedAppCard(_ app: SharedAppItem) -> some View {
        let preview = app.preview
        let resolvedPreview = preview?.isEmpty == true ? nil : preview

        return Button {
            openSharedApp(app)
        } label: {
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Group {
                    if let nsImage = AppPreviewImageStore.image(appId: "shared-\(app.uuid)", base64: resolvedPreview) {
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

                            Text(app.icon ?? "\u{1F4F1}")
                                .font(.system(size: 32))
                        }
                        .aspectRatio(16.0 / 10.0, contentMode: .fit)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.surfaceBorder, lineWidth: 1)
                )

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: VSpacing.xs) {
                        Text(app.name)
                            .font(VFont.bodyBold)
                            .foregroundColor(VColor.textPrimary)
                            .lineLimit(1)

                        if let signer = app.signerDisplayName {
                            Text("by \(signer)")
                                .font(VFont.caption)
                                .foregroundColor(VColor.textMuted)
                                .lineLimit(1)
                        }
                    }

                    Text(Self.formatISO(app.installedAt))
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
            hoveredAppId = hovering ? "shared-\(app.uuid)" : nil
            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }

    private func openSharedApp(_ app: SharedAppItem) {
        let safeName = app.name
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
        let sanitizedUUID = app.uuid
            .replacingOccurrences(of: "\\", with: "")
            .replacingOccurrences(of: "'", with: "")
        let entryURL = "\(VellumAppSchemeHandler.scheme)://\(sanitizedUUID)/index.html"
        let html = """
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"><title>\(safeName)</title></head>
        <body><script>window.location.href = '\(entryURL)';</script></body>
        </html>
        """
        let surfaceMsg = UiSurfaceShowMessage(
            sessionId: "shared-app",
            surfaceId: "shared-app-\(app.uuid)",
            surfaceType: "dynamic_page",
            title: app.name,
            data: AnyCodable(["html": html]),
            actions: nil,
            display: "panel",
            messageId: nil
        )
        onOpenSharedApp?(surfaceMsg)
    }

    // MARK: - Daemon Data Fetching

    private func fetchAllApps() {
        isLoadingAll = true
        let previousHandler = daemonClient.onAppsListResponse
        daemonClient.onAppsListResponse = { response in
            daemonClient.onAppsListResponse = previousHandler
            self.allLocalApps = response.apps
            self.isLoadingAll = false
            self.hasFetchedAll = true
        }
        do {
            try daemonClient.sendAppsList()
        } catch {
            isLoadingAll = false
            hasFetchedAll = true
            daemonClient.onAppsListResponse = previousHandler
        }
    }

    private func fetchSharedApps() {
        isLoadingShared = true
        let previousHandler = daemonClient.onSharedAppsListResponse
        daemonClient.onSharedAppsListResponse = { response in
            daemonClient.onSharedAppsListResponse = previousHandler
            self.sharedApps = response.apps
            self.isLoadingShared = false
            self.hasFetchedShared = true
        }
        do {
            try daemonClient.sendSharedAppsList()
        } catch {
            isLoadingShared = false
            hasFetchedShared = true
            daemonClient.onSharedAppsListResponse = previousHandler
        }
    }

    private func fetchPreviewForAllApp(_ app: AppItem) {
        guard previewCache[app.id] == nil, previewTasks[app.id] == nil else { return }

        let stream = daemonClient.subscribe()
        do {
            try daemonClient.sendAppPreview(appId: app.id)
        } catch { return }

        let appId = app.id
        let task = Task { @MainActor in
            defer { self.previewTasks.removeValue(forKey: appId) }
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

    /// All daemon-fetched local apps, filtered by search text.
    private var filteredAllApps: [AppItem] {
        guard !searchText.isEmpty else { return allLocalApps }
        return allLocalApps.filter {
            $0.name.localizedCaseInsensitiveContains(searchText) ||
            ($0.description?.localizedCaseInsensitiveContains(searchText) ?? false)
        }
    }

    /// Shared apps filtered by search text.
    private var filteredSharedApps: [SharedAppItem] {
        guard !searchText.isEmpty else { return sharedApps }
        return sharedApps.filter {
            $0.name.localizedCaseInsensitiveContains(searchText) ||
            ($0.description?.localizedCaseInsensitiveContains(searchText) ?? false)
        }
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

    private static func formatEpochMs(_ epochMs: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(epochMs) / 1000)
        return dateFormatter.string(from: date)
    }

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        return f
    }()

    private static func formatISO(_ isoString: String) -> String {
        guard let date = isoFormatter.date(from: isoString) else { return isoString }
        return dateFormatter.string(from: date)
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
                gatewayBaseURL: "http://127.0.0.1:3000",
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
