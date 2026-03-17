import SwiftUI
import VellumAssistantShared

/// Unified display item for both local and shared apps.
private struct DisplayAppItem: Identifiable {
    let id: String
    let name: String
    let description: String?
    let icon: String?
    let preview: String?
    let dateLabel: String
    let isShared: Bool
    let trustTier: String?
    let signerDisplayName: String?
    let version: String?
    let updateAvailable: Bool?
    let appType: String?

    /// For local apps: the app store ID used for bundling.
    let localAppId: String?
    /// For shared apps: the UUID used for deletion and re-sharing.
    let sharedUUID: String?
}

struct GeneratedPanel: View {
    var onClose: () -> Void
    @Binding var isExpanded: Bool
    let daemonClient: DaemonClient
    let gatewayBaseURL: String
    /// When set, app opens route to the workspace instead of a floating NSPanel.
    var onOpenApp: ((UiSurfaceShowMessage) -> Void)?
    /// Called to record an app open in the sidebar's recent apps list.
    var onRecordAppOpen: ((_ id: String, _ name: String, _ icon: String?, _ appType: String?) -> Void)?

    @State private var searchText = ""
    @State private var displayItems: [DisplayAppItem] = []
    @State private var isLoading = false
    @State private var hoveredAppId: String?
    @State private var sharingAppId: String?
    @State private var isBundling = false
    @State private var shareFileURL: URL?
    @State private var shareAppName: String = ""
    @State private var shareAppIcon: NSImage?
    @State private var showShareSheet = false
    @State private var pendingDeleteId: String?

    @State private var fetchAppsTask: Task<Void, Never>?
    @State private var fetchAppsGeneration = 0

    /// Cache of lazily-loaded preview screenshots keyed by local app ID.
    /// Empty string is used as a sentinel for "fetched but no preview available".
    @State private var previewCache: [String: String] = [:]
    /// In-flight preview fetch tasks, keyed by local app ID, so they can be cancelled.
    @State private var previewTasks: [String: Task<Void, Never>] = [:]

    init(onClose: @escaping () -> Void, isExpanded: Binding<Bool> = .constant(false), daemonClient: DaemonClient, gatewayBaseURL: String = "", onOpenApp: ((UiSurfaceShowMessage) -> Void)? = nil, onRecordAppOpen: ((_ id: String, _ name: String, _ icon: String?, _ appType: String?) -> Void)? = nil) {
        self.onClose = onClose
        self._isExpanded = isExpanded
        self.daemonClient = daemonClient
        self.gatewayBaseURL = gatewayBaseURL
        self.onOpenApp = onOpenApp
        self.onRecordAppOpen = onRecordAppOpen
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header
            HStack {
                Button(action: { withAnimation(VAnimation.fast) { isExpanded.toggle() } }) {
                    VIconView(isExpanded ? .minimize : .maximize, size: 11)
                        .foregroundColor(VColor.contentTertiary)
                        .frame(width: 28, height: 28, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isExpanded ? "Exit full screen" : "Enter full screen")

                Text("Dynamic")
                    .font(VFont.panelTitle)
                    .foregroundColor(VColor.contentDefault)

                Spacer()

                Button(action: onClose) {
                    VIconView(.x, size: 12)
                        .foregroundColor(VColor.contentTertiary)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close Dynamic")
            }
            .padding(.horizontal, VSpacing.xl)
            .padding(.vertical, VSpacing.lg)

            Divider()
                .background(VColor.borderBase)

            // Search bar
            if !displayItems.isEmpty || !searchText.isEmpty {
                HStack(spacing: VSpacing.sm) {
                    VIconView(.search, size: 12)
                        .foregroundColor(VColor.contentTertiary)

                    TextField("Filter pages...", text: $searchText)
                        .textFieldStyle(.plain)
                        .font(VFont.mono)
                        .foregroundColor(VColor.contentDefault)

                    if !searchText.isEmpty {
                        Button(action: { searchText = "" }) {
                            VIconView(.circleX, size: 12)
                                .foregroundColor(VColor.contentTertiary)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(VSpacing.md)
                .background(VColor.surfaceActive)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .padding(.horizontal, VSpacing.xl)
                .padding(.top, VSpacing.md)
            }

            // Scrollable content
            ScrollView {
                Group {
                    if isLoading {
                        HStack {
                            Spacer()
                            ProgressView()
                                .controlSize(.small)
                            Spacer()
                        }
                        .frame(height: 250)
                    } else if displayItems.isEmpty {
                        VEmptyState(
                            title: "No dynamic pages",
                            subtitle: "Dynamic UIs generated by your assistant will appear here",
                            icon: VIcon.wand.rawValue
                        )
                    } else if filteredItems.isEmpty {
                        VEmptyState(
                            title: "No results",
                            subtitle: "No pages matched \"\(searchText)\"",
                            icon: VIcon.search.rawValue
                        )
                        .frame(height: 100)
                    } else {
                        LazyVStack(alignment: .leading, spacing: VSpacing.lg) {
                            // Documents section
                            if !documentItems.isEmpty {
                                VStack(alignment: .leading, spacing: VSpacing.sm) {
                                    HStack {
                                        Text("Documents")
                                            .font(VFont.display)
                                            .foregroundColor(VColor.contentTertiary)
                                        Spacer()
                                        Text("\(documentItems.count)")
                                            .font(VFont.caption)
                                            .foregroundColor(VColor.contentTertiary)
                                    }
                                    .padding(.horizontal, VSpacing.xs)

                                    LazyVStack(spacing: VSpacing.md) {
                                        ForEach(documentItems) { item in
                                            appRow(item)
                                                .onAppear { fetchPreviewIfNeeded(item) }
                                        }
                                    }
                                }
                            }

                            // Dynamic pages section
                            if !otherItems.isEmpty {
                                VStack(alignment: .leading, spacing: VSpacing.sm) {
                                    if !documentItems.isEmpty {
                                        HStack {
                                            Text("Pages")
                                                .font(VFont.display)
                                                .foregroundColor(VColor.contentTertiary)
                                            Spacer()
                                            Text("\(otherItems.count)")
                                                .font(VFont.caption)
                                                .foregroundColor(VColor.contentTertiary)
                                        }
                                        .padding(.horizontal, VSpacing.xs)
                                    }

                                    LazyVStack(spacing: VSpacing.md) {
                                        ForEach(otherItems) { item in
                                            appRow(item)
                                                .onAppear { fetchPreviewIfNeeded(item) }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                .padding(VSpacing.xl)
            }
        }
        .background(VColor.surfaceBase)
        .onAppear {
            fetchApps()
        }
        .onDisappear {
            fetchAppsTask?.cancel()
            fetchAppsTask = nil
            for task in previewTasks.values { task.cancel() }
            previewTasks.removeAll()
        }
    }

    private var filteredItems: [DisplayAppItem] {
        guard !searchText.isEmpty else { return displayItems }
        return displayItems.filter {
            // Always keep the row being shared so its ShareSheetButton stays
            // in the view tree even if the search text changes mid-bundle.
            if let sharingAppId, $0.id == sharingAppId { return true }
            return $0.name.localizedCaseInsensitiveContains(searchText) ||
                ($0.description?.localizedCaseInsensitiveContains(searchText) ?? false)
        }
    }

    /// Document apps (appId starts with "doc-")
    private var documentItems: [DisplayAppItem] {
        filteredItems.filter { $0.localAppId?.starts(with: "doc-") ?? false }
    }

    /// Non-document apps
    private var otherItems: [DisplayAppItem] {
        filteredItems.filter { !($0.localAppId?.starts(with: "doc-") ?? false) }
    }

    // MARK: - App Row

    private func appRow(_ item: DisplayAppItem) -> some View {
        let isHovered = hoveredAppId == item.id
        let isBundlingThis = sharingAppId == item.id && isBundling
        let rawPreview = item.isShared ? item.preview : previewCache[item.localAppId ?? ""]
        // Empty string is a sentinel for "no preview available" — treat as nil
        let preview = rawPreview?.isEmpty == true ? nil : rawPreview

        return HStack(spacing: VSpacing.md) {
            // Icon / Preview thumbnail
            if let nsImage = AppPreviewImageStore.image(appId: item.id, base64: preview) {
                Image(nsImage: nsImage)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: 48, height: 48)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
            } else {
                let isDocument = item.localAppId?.starts(with: "doc-") ?? false
                Text(isDocument ? "📝" : (item.icon ?? "\u{1F4F1}"))
                    .font(.system(size: 20))
                    .frame(width: 28, height: 28)
            }

            // Name + badges + description
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: VSpacing.xs) {
                    Text(item.name)
                        .font(VFont.bodyBold)
                        .foregroundColor(VColor.contentDefault)
                        .lineLimit(1)

                    if let version = item.version {
                        Text("v\(version)")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                    }

                    if item.isShared {
                        sharedBadge
                    }

                    if let tier = item.trustTier {
                        trustBadge(tier: tier)
                    }

                    if item.appType == "site" {
                        Text("Site")
                            .font(VFont.small)
                            .foregroundColor(VColor.systemPositiveStrong)
                            .padding(.horizontal, VSpacing.xs)
                            .padding(.vertical, 1)
                            .background(VColor.systemPositiveStrong.opacity(0.5))
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.xs))
                    }

                    if item.updateAvailable == true {
                        updateAvailableBadge
                    }
                }

                if let description = item.description, !description.isEmpty {
                    Text(description)
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)
                        .lineLimit(2)
                }

                Text(item.dateLabel)
                    .font(VFont.small)
                    .foregroundColor(VColor.contentTertiary)
            }

            Spacer()

            // Action buttons — visible on hover
            let showingShareSheet = showShareSheet && sharingAppId == item.id
            if isHovered || isBundlingThis || showingShareSheet {
                HStack(spacing: VSpacing.xs) {
                    if isBundlingThis {
                        ProgressView()
                            .controlSize(.mini)
                            .frame(width: 24, height: 24)

                        // Keep the ShareSheetButton in the view tree during
                        // bundling so the NSButton stays attached to a window.
                        // It's hidden but will be ready when bundling completes.
                        shareButton(for: item)
                            .frame(width: 0, height: 0)
                            .opacity(0)
                    } else {
                        shareButton(for: item)

                        if item.isShared {
                            forkButton(for: item)
                            deleteButton(for: item)
                        }
                    }
                }
            }
        }
        .padding(VSpacing.lg)
        .background(isHovered ? VColor.surfaceActive : VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(item.isShared ? VColor.primaryHover.opacity(0.4) : VColor.systemPositiveStrong.opacity(0.4), lineWidth: 1)
        )
        .contentShape(Rectangle())
        .onTapGesture {
            MainActor.assumeIsolated { openApp(item) }
        }
        .onHover { hovering in
            withAnimation(VAnimation.fast) {
                if hovering {
                    hoveredAppId = item.id
                } else if !showShareSheet {
                    hoveredAppId = nil
                }
            }
        }
    }

    // MARK: - Badges

    private var sharedBadge: some View {
        HStack(spacing: 2) {
            VIconView(.users, size: 8)
            Text("Shared")
                .font(VFont.small)
        }
        .foregroundColor(VColor.systemPositiveWeak)
        .padding(.horizontal, 5)
        .padding(.vertical, 1)
        .background(VColor.borderActive.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
    }

    private var updateAvailableBadge: some View {
        HStack(spacing: 2) {
            VIconView(.circleArrowUp, size: 8)
            Text("Update available")
                .font(VFont.small)
        }
        .foregroundColor(VColor.primaryBase)
        .padding(.horizontal, 5)
        .padding(.vertical, 1)
        .background(VColor.primaryBase.opacity(0.15))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
    }

    private func trustBadge(tier: String) -> some View {
        let (icon, color): (VIcon, Color) = {
            switch tier {
            case "verified":
                return (.badgeCheck, VColor.systemPositiveStrong)
            case "signed":
                return (.badgeCheck, VColor.contentSecondary)
            case "unsigned":
                return (.triangleAlert, VColor.systemNegativeHover)
            case "tampered":
                return (.badgeX, VColor.systemNegativeStrong)
            default:
                return (.info, VColor.contentTertiary)
            }
        }()

        return VIconView(icon, size: 10)
            .foregroundColor(color)
    }

    // MARK: - Buttons

    @ViewBuilder
    private func shareButton(for item: DisplayAppItem) -> some View {
        if let localId = item.localAppId {
            ZStack {
                AppSharePanel(
                    items: shareFileURL != nil && sharingAppId == item.id ? [shareFileURL!] : [],
                    isPresented: Binding(
                        get: { showShareSheet && sharingAppId == item.id },
                        set: { newValue in
                            showShareSheet = newValue
                            if !newValue { sharingAppId = nil }
                        }
                    ),
                    appName: shareAppName,
                    appIcon: shareAppIcon,
                    appId: sharingAppId == item.id ? localId : nil,
                    gatewayBaseURL: gatewayBaseURL
                )
                .frame(width: 0, height: 0)
                .opacity(0)

                VButton(label: "Share", iconOnly: VIcon.share.rawValue, style: .ghost) {
                    bundleAndShare(appId: localId, itemId: item.id)
                }
            }
        } else if item.isShared, let uuid = item.sharedUUID {
            ZStack {
                AppSharePanel(
                    items: shareFileURL != nil && sharingAppId == item.id ? [shareFileURL!] : [],
                    isPresented: Binding(
                        get: { showShareSheet && sharingAppId == item.id },
                        set: { newValue in
                            showShareSheet = newValue
                            if !newValue { sharingAppId = nil }
                        }
                    ),
                    appName: shareAppName,
                    appIcon: shareAppIcon,
                    gatewayBaseURL: gatewayBaseURL
                )
                .frame(width: 0, height: 0)
                .opacity(0)

                VButton(label: "Share", iconOnly: VIcon.share.rawValue, style: .ghost) {
                    reshareApp(uuid: uuid, itemId: item.id)
                }
            }
        }
    }

    private func forkButton(for item: DisplayAppItem) -> some View {
        VButton(label: "Fork", iconOnly: VIcon.gitBranch.rawValue, style: .ghost) {
            forkSharedApp(item)
        }
    }

    private func deleteButton(for item: DisplayAppItem) -> some View {
        VButton(label: "Delete", iconOnly: VIcon.trash.rawValue, style: .ghost) {
            deleteSharedApp(item)
        }
    }

    // MARK: - Data Fetching

    @State private var localApps: [AppItem] = []
    @State private var sharedApps: [SharedAppItem] = []

    private func fetchApps() {
        fetchAppsTask?.cancel()

        isLoading = true
        fetchAppsGeneration += 1
        let generation = fetchAppsGeneration

        let task = Task { @MainActor in
            defer {
                if fetchAppsGeneration == generation {
                    fetchAppsTask = nil
                }
            }

            async let localResult: [AppItem] = {
                do {
                    return try await AppsLoader.load()
                } catch {
                    return []
                }
            }()

            async let sharedResult: [SharedAppItem] = SharedAppsLoader.load()

            let (fetchedLocal, fetchedShared) = await (localResult, sharedResult)
            guard fetchAppsGeneration == generation else { return }

            localApps = fetchedLocal
            sharedApps = fetchedShared
            buildDisplayItems()
            isLoading = false
        }
        fetchAppsTask = task
    }

    /// Fetch preview for a local app when its row appears on screen.
    private func fetchPreviewIfNeeded(_ item: DisplayAppItem) {
        guard let appId = item.localAppId, !item.isShared else { return }
        // Skip if already cached (including empty-string sentinel) or in-flight
        guard previewCache[appId] == nil, previewTasks[appId] == nil else { return }

        let task = Task { @MainActor in
            let response = await AppsClient().fetchAppPreview(appId: appId)
            self.previewCache[appId] = response?.preview ?? ""
            self.previewTasks.removeValue(forKey: appId)
        }
        previewTasks[appId] = task
    }

    private func buildDisplayItems() {
        var items: [DisplayAppItem] = []

        // Local apps — preview is loaded lazily via fetchPreviewIfNeeded
        for app in localApps {
            items.append(DisplayAppItem(
                id: "local-\(app.id)",
                name: app.name,
                description: app.description,
                icon: app.icon,
                preview: nil,
                dateLabel: formatDate(app.createdAt),
                isShared: false,
                trustTier: nil,
                signerDisplayName: nil,
                version: app.version,
                updateAvailable: nil,
                appType: nil,
                localAppId: app.id,
                sharedUUID: nil
            ))
        }

        // Shared apps
        for app in sharedApps {
            items.append(DisplayAppItem(
                id: "shared-\(app.uuid)",
                name: app.name,
                description: app.description,
                icon: app.icon,
                preview: app.preview,
                dateLabel: formatISO(app.installedAt),
                isShared: true,
                trustTier: app.trustTier,
                signerDisplayName: app.signerDisplayName,
                version: app.version,
                updateAvailable: app.updateAvailable,
                appType: nil,
                localAppId: nil,
                sharedUUID: app.uuid
            ))
        }

        displayItems = items
    }

    // MARK: - Open App

    @MainActor private func openApp(_ item: DisplayAppItem) {
        if let localId = item.localAppId {
            // Local apps: ask the daemon to open via ui_surface_show.
            // When onOpenApp is set, the daemon's response will be intercepted
            // by SurfaceManager and routed to the workspace (see PR 5).
            onRecordAppOpen?(localId, item.name, item.icon, item.appType)
            Task { await AppsClient.openAppAndDispatchSurface(id: localId, daemonClient: daemonClient) }
        } else if let uuid = item.sharedUUID {
            // Shared apps: construct surface from unpacked files on disk
            // Sanitize to prevent XSS — name comes from external bundle metadata
            let safeName = htmlEscape(item.name)
            let sanitizedUUID = uuid
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
                conversationId: "shared-app",
                surfaceId: "shared-app-\(uuid)",
                surfaceType: "dynamic_page",
                title: item.name,
                data: AnyCodable(["html": html]),
                actions: nil,
                display: "panel",
                messageId: nil
            )
            if let onOpenApp {
                onOpenApp(surfaceMsg)
            } else {
                daemonClient.onSurfaceShow?(surfaceMsg)
            }
        }
    }

    // MARK: - Bundle & Share

    private func bundleAndShare(appId: String, itemId: String) {
        guard !isBundling else { return }
        sharingAppId = itemId
        isBundling = true

        Task { @MainActor in
            let response = await AppsClient().bundleApp(appId: appId)

            if let response {
                let url = MainWindowView.cleanBundleURL(bundlePath: response.bundlePath, appName: response.manifest.name)
                MainWindowView.applyFileIcon(to: url, iconBase64: response.iconImageBase64, emojiIcon: response.manifest.icon, appName: response.manifest.name)
                self.shareFileURL = url
                self.shareAppName = response.manifest.name
                self.shareAppIcon = MainWindowView.buildAppIcon(iconBase64: response.iconImageBase64, emojiIcon: response.manifest.icon, appName: response.manifest.name)
                self.isBundling = false
                self.showShareSheet = true
            } else {
                self.isBundling = false
                self.sharingAppId = nil
            }
        }
    }

    private func reshareApp(uuid: String, itemId: String) {
        // Share the existing unpacked directory as a folder
        let appDir = BundleSandbox.sharedAppsDirectory.appendingPathComponent(uuid)
        guard FileManager.default.fileExists(atPath: appDir.path) else { return }
        let item = displayItems.first { $0.id == itemId }
        sharingAppId = itemId
        shareFileURL = appDir
        shareAppName = item?.name ?? "App"
        shareAppIcon = nil
        showShareSheet = true
    }

    // MARK: - Delete Shared App

    private func deleteSharedApp(_ item: DisplayAppItem) {
        guard let uuid = item.sharedUUID else { return }

        Task { @MainActor in
            let response = await AppsClient().deleteSharedApp(uuid: uuid)
            if response?.success == true {
                self.sharedApps.removeAll { $0.uuid == uuid }
                self.buildDisplayItems()
            }
        }
    }

    // MARK: - Fork Shared App

    private func forkSharedApp(_ item: DisplayAppItem) {
        guard let uuid = item.sharedUUID else { return }

        Task { @MainActor in
            let response = await AppsClient().forkSharedApp(uuid: uuid)
            if response?.success == true {
                self.fetchApps()
            }
        }
    }

    // MARK: - Helpers

    private func formatDate(_ epochMs: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(epochMs) / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    private func formatISO(_ isoString: String) -> String {
        let isoFormatter = ISO8601DateFormatter()
        guard let date = isoFormatter.date(from: isoString) else { return isoString }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    private func htmlEscape(_ string: String) -> String {
        string
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
    }
}

