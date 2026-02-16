import SwiftUI
import VellumAssistantShared

/// Full-screen app directory view showing all local and shared apps as a card grid.
struct AppDirectoryView: View {
    let daemonClient: DaemonClient
    let onBack: () -> Void
    let onOpenApp: (UiSurfaceShowMessage) -> Void

    @State private var searchText = ""
    @State private var isSearchExpanded = false
    @State private var displayItems: [DirectoryAppItem] = []
    @State private var isLoading = false
    @State private var hoveredAppId: String?

    @State private var localApps: [AppItem] = []
    @State private var sharedApps: [SharedAppItem] = []
    @State private var pendingResponses = 0

    private let columns = [
        GridItem(.flexible(), spacing: VSpacing.lg),
        GridItem(.flexible(), spacing: VSpacing.lg),
        GridItem(.flexible(), spacing: VSpacing.lg),
    ]

    var body: some View {
        ZStack {
            VColor.background.ignoresSafeArea()

            VStack(spacing: 0) {
                // Top bar
                HStack {
                    backButton

                    Spacer()

                    Text("App Directory")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundColor(VColor.textPrimary)

                    Spacer()

                    // Collapsible search
                    if !displayItems.isEmpty || !searchText.isEmpty {
                        HStack(spacing: VSpacing.sm) {
                            if isSearchExpanded {
                                TextField("Search apps...", text: $searchText)
                                    .textFieldStyle(.plain)
                                    .font(VFont.body)
                                    .foregroundColor(VColor.textPrimary)
                                    .frame(width: 160)

                                if !searchText.isEmpty {
                                    Button(action: { searchText = "" }) {
                                        Image(systemName: "xmark.circle.fill")
                                            .font(.system(size: 12))
                                            .foregroundColor(VColor.textMuted)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }

                            Button(action: {
                                withAnimation(VAnimation.fast) {
                                    isSearchExpanded.toggle()
                                    if !isSearchExpanded {
                                        searchText = ""
                                    }
                                }
                            }) {
                                Image(systemName: "magnifyingglass")
                                    .font(.system(size: 13, weight: .medium))
                                    .foregroundColor(VColor.textSecondary)
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.horizontal, isSearchExpanded ? VSpacing.md : VSpacing.sm)
                        .padding(.vertical, VSpacing.sm)
                        .background(
                            isSearchExpanded
                                ? AnyShapeStyle(VColor.surface)
                                : AnyShapeStyle(.clear)
                        )
                        .clipShape(Capsule())
                        .overlay(
                            isSearchExpanded
                                ? Capsule().stroke(VColor.surfaceBorder, lineWidth: 1)
                                : nil
                        )
                    } else {
                        // Balance the back button width when no search
                        Color.clear.frame(width: 80, height: 1)
                    }
                }
                .padding(.horizontal, VSpacing.xl)
                .padding(.top, VSpacing.md)
                .padding(.bottom, VSpacing.lg)

                // Content
                ScrollView {
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
                            icon: "square.grid.2x2"
                        )
                        .frame(maxWidth: .infinity)
                        .padding(.top, VSpacing.xxxl)
                    } else if filteredItems.isEmpty {
                        VEmptyState(
                            title: "No results",
                            subtitle: "No apps matched \"\(searchText)\"",
                            icon: "magnifyingglass"
                        )
                        .frame(maxWidth: .infinity)
                        .padding(.top, VSpacing.xxxl)
                    } else {
                        LazyVGrid(columns: columns, spacing: VSpacing.lg) {
                            ForEach(filteredItems) { item in
                                appCard(item)
                            }
                        }
                        .padding(.horizontal, VSpacing.xl)
                        .padding(.bottom, VSpacing.xl)
                    }
                }
            }
        }
        .onAppear { fetchApps() }
    }

    // MARK: - Back Button

    private var backButton: some View {
        Button(action: onBack) {
            HStack(spacing: VSpacing.xs) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 12, weight: .semibold))
                Text("Chat")
                    .font(VFont.bodyMedium)
            }
            .foregroundColor(VColor.textPrimary)
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .background(
                Capsule()
                    .fill(VColor.surface.opacity(0.85))
                    .overlay(Capsule().stroke(VColor.surfaceBorder, lineWidth: 1))
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Back to chat")
    }

    // MARK: - App Card

    private func appCard(_ item: DirectoryAppItem) -> some View {
        let isHovered = hoveredAppId == item.id

        return VStack(alignment: .leading, spacing: 0) {
            // Preview thumbnail or placeholder
            Group {
                if let preview = item.preview,
                   let data = Data(base64Encoded: preview),
                   let nsImage = NSImage(data: data) {
                    Image(nsImage: nsImage)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(height: 160)
                        .clipped()
                } else {
                    ZStack {
                        VColor.backgroundSubtle

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
                        .foregroundColor(VColor.textPrimary)
                        .lineLimit(1)

                    if item.appType == "site" {
                        Text("Site")
                            .font(VFont.small)
                            .foregroundColor(Emerald._400)
                            .padding(.horizontal, VSpacing.xs)
                            .padding(.vertical, 1)
                            .background(Emerald._900.opacity(0.5))
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.xs))
                    }

                    if item.isShared {
                        HStack(spacing: 2) {
                            Image(systemName: "person.2.fill")
                                .font(.system(size: 8))
                            Text("Shared")
                                .font(VFont.small)
                        }
                        .foregroundColor(Violet._400)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Violet._900.opacity(0.5))
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                    }
                }

                Text(item.dateLabel)
                    .font(VFont.small)
                    .foregroundColor(VColor.textMuted)
            }
            .padding(VSpacing.md)
        }
        .background(isHovered ? Slate._800 : VColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(isHovered ? VColor.surfaceBorder.opacity(0.8) : VColor.surfaceBorder.opacity(0.4), lineWidth: 1)
        )
        .scaleEffect(isHovered ? 1.02 : 1.0)
        .animation(VAnimation.fast, value: isHovered)
        .contentShape(Rectangle())
        .onTapGesture { openApp(item) }
        .onHover { hovering in
            withAnimation(VAnimation.fast) {
                hoveredAppId = hovering ? item.id : nil
            }
            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
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
            daemonClient.onAppsListResponse = { response in
                self.localApps = response.apps
                self.pendingResponses -= 1
                if self.pendingResponses <= 0 {
                    self.buildDisplayItems()
                    self.isLoading = false
                }
            }

            daemonClient.onSharedAppsListResponse = { response in
                self.sharedApps = response.apps
                self.pendingResponses -= 1
                if self.pendingResponses <= 0 {
                    self.buildDisplayItems()
                    self.isLoading = false
                }
            }

            daemonClient.onError = { _ in
                if self.isLoading {
                    self.pendingResponses -= 1
                    if self.pendingResponses <= 0 {
                        self.buildDisplayItems()
                        self.isLoading = false
                    }
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
                buildDisplayItems()
                isLoading = false
            }
        }
    }

    private func buildDisplayItems() {
        var items: [DirectoryAppItem] = []

        for app in localApps {
            items.append(DirectoryAppItem(
                id: "local-\(app.id)",
                name: app.name,
                description: app.description,
                icon: app.icon,
                preview: app.preview,
                dateLabel: formatDate(app.createdAt),
                isShared: false,
                appType: app.appType,
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

    private func openApp(_ item: DirectoryAppItem) {
        if let localId = item.localAppId {
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
                display: "panel"
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

#Preview {
    AppDirectoryView(
        daemonClient: DaemonClient(),
        onBack: {},
        onOpenApp: { _ in }
    )
    .frame(width: 900, height: 600)
}
