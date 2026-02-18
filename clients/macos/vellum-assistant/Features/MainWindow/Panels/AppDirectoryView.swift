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

    private let columns = [
        GridItem(.flexible(minimum: 200), spacing: VSpacing.lg, alignment: .top),
        GridItem(.flexible(minimum: 200), spacing: VSpacing.lg, alignment: .top),
    ]

    var body: some View {
        VSidePanel(title: "Directory", onClose: onBack, pinnedContent: {
            // Search bar (only when there are items to search)
            if !displayItems.isEmpty || !searchText.isEmpty {
                HStack(spacing: VSpacing.sm) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(VColor.textMuted)

                    TextField("Search apps...", text: $searchText)
                        .textFieldStyle(.plain)
                        .font(VFont.body)
                        .foregroundColor(VColor.textPrimary)

                    if !searchText.isEmpty {
                        Button(action: { searchText = "" }) {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 12))
                                .foregroundColor(VColor.textMuted)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.sm)
                .background(VColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.surfaceBorder, lineWidth: 1)
                )
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.md)

                Divider().background(VColor.surfaceBorder)
            }
        }) {
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
                .padding(.bottom, VSpacing.md)
            }
        }
        .onAppear { fetchApps() }
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
        .background(isHovered ? VColor.ghostHover : VColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.06), radius: 4, y: 2)
        .overlay(alignment: .topTrailing) {
            if isHovered, let localId = item.localAppId, onPinApp != nil {
                Button {
                    onPinApp?(localId, item.name, item.icon, item.appType)
                } label: {
                    Image(systemName: "pin")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(VColor.textPrimary)
                        .rotationEffect(.degrees(-45))
                        .frame(width: 28, height: 28)
                        .background(VColor.surface.opacity(0.9))
                        .clipShape(Circle())
                        .overlay(Circle().stroke(VColor.surfaceBorder, lineWidth: 1))
                }
                .buttonStyle(.plain)
                .padding(VSpacing.sm)
                .transition(.opacity)
                .accessibilityLabel("Pin \(item.name)")
            }
        }
        .scaleEffect(isHovered ? 1.02 : 1.0)
        .animation(VAnimation.fast, value: isHovered)
        .contentShape(Rectangle())
        .onTapGesture { MainActor.assumeIsolated { openApp(item) } }
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

struct AppDirectoryView_Previews: PreviewProvider {
    static var previews: some View {
        AppDirectoryView(
            daemonClient: DaemonClient(),
            onBack: {},
            onOpenApp: { _ in }
        )
        .frame(width: 900, height: 600)
    }
}
