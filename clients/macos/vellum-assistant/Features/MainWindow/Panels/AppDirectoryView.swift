import SwiftUI
import VellumAssistantShared

/// Full-screen app directory view showing all local and shared apps as a card grid.
struct AppDirectoryView: View {
    let daemonClient: DaemonClient
    let onBack: () -> Void
    let onOpenApp: (UiSurfaceShowMessage) -> Void
    /// Called to record an app open in the sidebar's recent apps list.
    var onRecordAppOpen: ((_ id: String, _ name: String, _ icon: String?, _ appType: String?) -> Void)?
    /// Called to pin an app from the directory into the sidebar.
    var onPinApp: ((_ id: String, _ name: String, _ icon: String?, _ appType: String?) -> Void)?

    @State private var searchText = ""
    @State private var displayItems: [DirectoryAppItem] = []
    @State private var isLoading = false
    @State private var hoveredAppId: String?

    @State private var localApps: [AppItem] = []
    @State private var sharedApps: [SharedAppItem] = []
    @State private var pendingResponses = 0

    /// Cache of lazily-loaded preview screenshots keyed by local app ID.
    /// Empty string is used as a sentinel for "fetched but no preview available".
    @State private var previewCache: [String: String] = [:]
    /// In-flight preview fetch tasks, keyed by local app ID, so they can be cancelled.
    @State private var previewTasks: [String: Task<Void, Never>] = [:]

    private let columns = [
        GridItem(.flexible(minimum: 160), spacing: VSpacing.lg, alignment: .top),
        GridItem(.flexible(minimum: 160), spacing: VSpacing.lg, alignment: .top),
        GridItem(.flexible(minimum: 160), spacing: VSpacing.lg, alignment: .top),
    ]

    /// Maximum width of the centered content area.
    private let maxContentWidth: CGFloat = 1100

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // Header row: title (left) + centered search + trailing space for close button
                HStack(spacing: 0) {
                    Text("Directory")
                        .font(VFont.panelTitle)
                        .foregroundColor(VColor.contentDefault)

                    Spacer(minLength: VSpacing.lg)

                    if !displayItems.isEmpty || !searchText.isEmpty {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.search, size: 11)
                                .foregroundColor(VColor.contentTertiary)

                            TextField("Search apps...", text: $searchText)
                                .textFieldStyle(.plain)
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentDefault)

                            if !searchText.isEmpty {
                                Button(action: { searchText = "" }) {
                                    VIconView(.circleX, size: 10)
                                        .foregroundColor(VColor.contentTertiary)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, VSpacing.sm)
                        .frame(height: 26)
                        .background(VColor.surfaceBase)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.sm)
                                .stroke(VColor.borderBase, lineWidth: 1)
                        )
                        .frame(maxWidth: 280)
                    }

                    Spacer(minLength: VSpacing.lg)
                }
                .padding(.top, VSpacing.xxl)
                .padding(.bottom, VSpacing.xl)
                .padding(.trailing, VSpacing.xxl)

                Divider().background(VColor.borderBase)
                    .padding(.bottom, VSpacing.xl)

                // Content
                if isLoading {
                    HStack {
                        Spacer()
                        ProgressView()
                            .controlSize(.regular)
                        Spacer()
                    }
                    .frame(height: 300)
                } else if displayItems.isEmpty {
                    VEmptyState(
                        title: "No apps yet",
                        subtitle: "Apps built with your assistant will appear here",
                        icon: VIcon.layoutGrid.rawValue
                    )
                    .frame(maxWidth: .infinity)
                    .padding(.top, VSpacing.xxxl)
                } else if filteredItems.isEmpty {
                    VEmptyState(
                        title: "No results",
                        subtitle: "No apps matched \"\(searchText)\"",
                        icon: VIcon.search.rawValue
                    )
                    .frame(maxWidth: .infinity)
                    .padding(.top, VSpacing.xxxl)
                } else {
                    LazyVGrid(columns: columns, spacing: VSpacing.lg) {
                        ForEach(filteredItems) { item in
                            appCard(item)
                                .onAppear { fetchPreviewIfNeeded(item) }
                        }
                    }
                    .padding(.bottom, VSpacing.xxl)
                }
            }
            .frame(maxWidth: maxContentWidth)
            .padding(.horizontal, VSpacing.xxl)
            .frame(maxWidth: .infinity)
        }
        .background(VColor.surfaceBase)
        .onAppear { fetchApps() }
        .onDisappear {
            for task in previewTasks.values { task.cancel() }
            previewTasks.removeAll()
        }
    }

    // MARK: - App Card

    private func appCard(_ item: DirectoryAppItem) -> some View {
        let isHovered = hoveredAppId == item.id
        let rawPreview = item.isShared ? item.preview : previewCache[item.localAppId ?? ""]
        // Empty string is a sentinel for "no preview available" — treat as nil
        let preview = rawPreview?.isEmpty == true ? nil : rawPreview

        return Button {
            openApp(item)
        } label: {
            VStack(alignment: .leading, spacing: 0) {
                // Preview thumbnail or placeholder
                Group {
                    if let nsImage = AppPreviewImageStore.image(appId: item.id, base64: preview) {
                        Image(nsImage: nsImage)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                            .frame(height: 160)
                            .clipped()
                    } else {
                        ZStack {
                            VColor.surfaceBase

                            Text(item.icon ?? "\u{1F4F1}")
                                .font(.system(size: 40))
                        }
                        .frame(height: 160)
                    }
                }
                .frame(maxWidth: .infinity)
                .clipShape(
                    UnevenRoundedRectangle(
                        topLeadingRadius: VRadius.lg,
                        bottomLeadingRadius: 0,
                        bottomTrailingRadius: 0,
                        topTrailingRadius: VRadius.lg
                    )
                )

                // Info section
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    HStack(spacing: VSpacing.xs) {
                        Text(item.name)
                            .font(VFont.bodyBold)
                            .foregroundColor(VColor.contentDefault)
                            .lineLimit(1)

                        if item.appType == "site" {
                            Text("Site")
                                .font(VFont.small)
                                .foregroundColor(VColor.systemPositiveStrong)
                                .padding(.horizontal, VSpacing.xs)
                                .padding(.vertical, 1)
                                .background(VColor.systemPositiveStrong.opacity(0.5))
                                .clipShape(RoundedRectangle(cornerRadius: VRadius.xs))
                        }

                        if item.isShared {
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
                    }

                    Text(item.dateLabel)
                        .font(VFont.small)
                        .foregroundColor(VColor.contentTertiary)
                }
                .padding(VSpacing.md)
            }
            .background(isHovered ? VColor.surfaceBase : VColor.surfaceBase)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.lg)
                    .stroke(VColor.borderBase, lineWidth: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .shadow(color: VColor.auxBlack.opacity(0.06), radius: 4, y: 2)
        .overlay(alignment: .topTrailing) {
            if isHovered, let localId = item.localAppId, onPinApp != nil {
                Button {
                    onPinApp?(localId, item.name, item.icon, item.appType)
                } label: {
                    VIconView(.pin, size: 11)
                        .foregroundColor(VColor.contentDefault)
                        .rotationEffect(.degrees(-45))
                        .frame(width: 28, height: 28)
                        .background(VColor.surfaceBase.opacity(0.9))
                        .clipShape(Circle())
                        .overlay(Circle().stroke(VColor.borderBase, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .padding(VSpacing.sm)
                .transition(.opacity)
                .accessibilityLabel("Pin \(item.name)")
            }
        }
        .scaleEffect(isHovered ? 1.02 : 1.0)
        .animation(VAnimation.fast, value: isHovered)
        .onHover { hovering in
            withAnimation(VAnimation.fast) {
                hoveredAppId = hovering ? item.id : nil
            }
        }
        .pointerCursor()
    }

    // MARK: - Filtering

    private var filteredItems: [DirectoryAppItem] {
        guard !searchText.isEmpty else { return displayItems }
        return displayItems.filter {
            $0.name.localizedCaseInsensitiveContains(searchText) ||
            ($0.description?.localizedCaseInsensitiveContains(searchText) ?? false)
        }
    }

    // MARK: - Data Fetching

    private func fetchApps() {
        isLoading = true
        pendingResponses = 2

        Task { @MainActor in
            // Save the previous onError handler so we can restore it once our
            // requests complete, avoiding swallowing unrelated daemon errors.
            let previousOnError = daemonClient.onError

            daemonClient.onAppsListResponse = { response in
                self.localApps = response.apps
                self.pendingResponses -= 1
                if self.pendingResponses <= 0 {
                    daemonClient.onError = previousOnError
                    self.buildDisplayItems()
                    self.isLoading = false
                }
            }

            daemonClient.onSharedAppsListResponse = { response in
                self.sharedApps = response.apps
                self.pendingResponses -= 1
                if self.pendingResponses <= 0 {
                    daemonClient.onError = previousOnError
                    self.buildDisplayItems()
                    self.isLoading = false
                }
            }

            daemonClient.onError = { error in
                if self.isLoading {
                    self.pendingResponses -= 1
                    if self.pendingResponses <= 0 {
                        daemonClient.onError = previousOnError
                        self.buildDisplayItems()
                        self.isLoading = false
                    }
                } else {
                    previousOnError?(error)
                }
            }

            do {
                try daemonClient.sendAppsList()
            } catch {
                pendingResponses -= 1
            }

            do {
                try daemonClient.sendSharedAppsList()
            } catch {
                pendingResponses -= 1
            }

            if pendingResponses <= 0 {
                daemonClient.onError = previousOnError
                buildDisplayItems()
                isLoading = false
            }
        }
    }

    /// Fetch preview for a local app when its card appears on screen.
    private func fetchPreviewIfNeeded(_ item: DirectoryAppItem) {
        guard let appId = item.localAppId, !item.isShared else { return }
        // Skip if already cached (including empty-string sentinel) or in-flight
        guard previewCache[appId] == nil, previewTasks[appId] == nil else { return }

        let stream = daemonClient.subscribe()
        do {
            try daemonClient.sendAppPreview(appId: appId)
        } catch { return }

        let task = Task { @MainActor in
            // 10-second timeout to avoid zombie subscribers
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

        // Cancel after timeout
        Task {
            try? await Task.sleep(nanoseconds: 10_000_000_000)
            if !task.isCancelled { task.cancel() }
        }

        previewTasks[appId] = task
    }

    private func buildDisplayItems() {
        var items: [DirectoryAppItem] = []

        for app in localApps {
            items.append(DirectoryAppItem(
                id: "local-\(app.id)",
                name: app.name,
                description: app.description,
                icon: app.icon,
                preview: nil,
                dateLabel: formatDate(app.createdAt),
                isShared: false,
                appType: nil,
                localAppId: app.id,
                sharedUUID: nil
            ))
        }

        for app in sharedApps {
            items.append(DirectoryAppItem(
                id: "shared-\(app.uuid)",
                name: app.name,
                description: app.description,
                icon: app.icon,
                preview: app.preview,
                dateLabel: formatISO(app.installedAt),
                isShared: true,
                appType: nil,
                localAppId: nil,
                sharedUUID: app.uuid
            ))
        }

        displayItems = items
    }

    // MARK: - Open App

    @MainActor private func openApp(_ item: DirectoryAppItem) {
        if let localId = item.localAppId {
            onRecordAppOpen?(localId, item.name, item.icon, item.appType)
            try? daemonClient.sendAppOpen(appId: localId)
        } else if let uuid = item.sharedUUID {
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
                sessionId: "shared-app",
                surfaceId: "shared-app-\(uuid)",
                surfaceType: "dynamic_page",
                title: item.name,
                data: AnyCodable(["html": html]),
                actions: nil,
                display: "panel",
                messageId: nil
            )
            onOpenApp(surfaceMsg)
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

/// Display model for directory app items.
private struct DirectoryAppItem: Identifiable {
    let id: String
    let name: String
    let description: String?
    let icon: String?
    let preview: String?
    let dateLabel: String
    let isShared: Bool
    let appType: String?
    let localAppId: String?
    let sharedUUID: String?
}

