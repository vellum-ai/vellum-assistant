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

    @State private var searchText = ""
    @State private var hoveredAppId: String?
    @State private var editingApp: AppListManager.AppItem?
    @State private var sharingAppId: String?
    @State private var shareFileURL: URL?
    @State private var shareAppName: String = ""
    @State private var shareAppIcon: NSImage?
    @State private var showShareSheet = false
    @State private var isBundling = false

    // Shared apps fetched from daemon
    @State private var sharedApps: [SharedAppItem] = []
    @State private var isLoadingShared = false
    @State private var hasFetchedShared = false
    @State private var sharedAppsTask: Task<Void, Never>?
    @State private var sharedAppsTaskGeneration = 0

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
            if appListManager.apps.isEmpty && sharedApps.isEmpty && hasFetchedShared {
                noAppsEmptyState
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    // Header
                    HStack(alignment: .center) {
                        Text("Things")
                            .font(VFont.panelTitle)
                            .foregroundColor(VColor.contentDefault)
                        Spacer()
                    }
                    .padding(.bottom, VSpacing.md)

                    Divider().background(VColor.borderBase)

                    mainContent
                }
                .padding(VSpacing.xl)
            }
        }
        .background(VColor.surfaceBase)
        .onAppear {
            if !hasFetchedShared { fetchSharedApps() }
        }
        .onDisappear {
            sharedAppsTask?.cancel()
            sharedAppsTask = nil
            for task in previewTasks.values { task.cancel() }
            previewTasks.removeAll()
        }
        .sheet(item: $editingApp) { app in
            AppIconPickerSheet(
                appName: app.name,
                currentIcon: resolvedIcon(for: app),
                onSave: { icon in
                    appListManager.updateAppIcon(id: app.id, icon: icon)
                }
            )
        }
    }

    // MARK: - Main Content

    private var mainContent: some View {
        ScrollView {
            VStack(spacing: VSpacing.xxl) {
                searchBar

                let pinned = filteredPinnedApps
                let recents = filteredRecentApps
                let shared = filteredSharedApps

                if !pinned.isEmpty {
                    appSection(title: "Pinned", apps: pinned)
                }

                if !recents.isEmpty {
                    appSection(title: "Recents", apps: recents)
                }

                if !shared.isEmpty {
                    sharedSection(title: "Shared", apps: shared)
                } else if isLoadingShared {
                    ProgressView()
                        .controlSize(.small)
                        .frame(maxWidth: .infinity)
                        .padding(.top, VSpacing.lg)
                }

                if pinned.isEmpty && recents.isEmpty && shared.isEmpty && !searchText.isEmpty {
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

    // MARK: - Empty State

    private var noAppsEmptyState: some View {
        VStack(spacing: VSpacing.xl) {
            VIconView(.layoutGrid, size: 40)
                .foregroundColor(VColor.contentTertiary)

            VStack(spacing: VSpacing.sm) {
                Text("No things yet")
                    .font(VFont.bodyBold)
                    .foregroundColor(VColor.contentSecondary)

                Text("Ask the assistant to build something")
                    .font(VFont.body)
                    .foregroundColor(VColor.contentTertiary)
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
        let appIcon = resolvedIcon(for: app)
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
                            VColor.surfaceBase

                            VIconView(appIcon, size: 32)
                                .foregroundColor(VColor.contentTertiary)
                        }
                        .aspectRatio(16.0 / 10.0, contentMode: .fit)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.borderBase, lineWidth: 1)
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
                                    hoveredAppId = nil
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
                        .foregroundColor(VColor.contentDefault)
                        .lineLimit(1)

                    Text(Self.formatDate(app.lastOpenedAt))
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                        .lineLimit(1)
                }
                .padding(.horizontal, VSpacing.xs)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            hoveredAppId = hovering ? app.id : nil
        }
        .pointerCursor()
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

    // MARK: - Shared App Card

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
                            VColor.surfaceBase

                            Text(app.icon ?? "\u{1F4F1}")
                                .font(.system(size: 32))
                        }
                        .aspectRatio(16.0 / 10.0, contentMode: .fit)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.borderBase, lineWidth: 1)
                )

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: VSpacing.xs) {
                        Text(app.name)
                            .font(VFont.bodyBold)
                            .foregroundColor(VColor.contentDefault)
                            .lineLimit(1)

                        if let signer = app.signerDisplayName {
                            Text("by \(signer)")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                                .lineLimit(1)
                        }
                    }

                    Text(Self.formatISO(app.installedAt))
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                        .lineLimit(1)
                }
                .padding(.horizontal, VSpacing.xs)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            hoveredAppId = hovering ? "shared-\(app.uuid)" : nil
        }
        .pointerCursor()
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

    // MARK: - Daemon Data Fetching

    private func fetchSharedApps() {
        guard sharedAppsTask == nil else { return }

        isLoadingShared = true
        sharedAppsTaskGeneration += 1
        let generation = sharedAppsTaskGeneration

        let task = Task { @MainActor in
            // Ignore cleanup from cancelled predecessors once a newer load starts.
            defer {
                if sharedAppsTaskGeneration == generation {
                    sharedAppsTask = nil
                }
            }

            do {
                let apps = try await SharedAppsLoader.load(using: daemonClient)
                guard sharedAppsTaskGeneration == generation else { return }
                sharedApps = apps
                hasFetchedShared = true
                isLoadingShared = false
            } catch is CancellationError {
                guard sharedAppsTaskGeneration == generation else { return }
                isLoadingShared = false
            } catch {
                guard sharedAppsTaskGeneration == generation else { return }
                sharedApps = []
                hasFetchedShared = true
                isLoadingShared = false
            }
        }
        sharedAppsTask = task
    }

    // MARK: - Sections

    private func appSection(title: String, apps: [AppListManager.AppItem]) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text(title)
                .font(VFont.headline)
                .foregroundColor(VColor.contentSecondary)

            LazyVGrid(columns: columns, spacing: VSpacing.xxl) {
                ForEach(apps) { app in
                    appCard(app)
                        .onAppear { fetchPreviewIfNeeded(app) }
                }
            }
        }
    }

    private func sharedSection(title: String, apps: [SharedAppItem]) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text(title)
                .font(VFont.headline)
                .foregroundColor(VColor.contentSecondary)

            LazyVGrid(columns: columns, spacing: VSpacing.xxl) {
                ForEach(apps) { app in
                    sharedAppCard(app)
                }
            }
        }
    }

    // MARK: - Helpers

    private func resolvedIcon(for app: AppListManager.AppItem) -> VIcon {
        if let rawValue = app.lucideIcon, let icon = VIcon(rawValue: rawValue) {
            return icon
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

