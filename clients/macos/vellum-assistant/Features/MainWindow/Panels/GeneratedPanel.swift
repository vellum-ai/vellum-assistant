import SwiftUI

/// Unified display item for both local and shared apps.
private struct DisplayAppItem: Identifiable {
    let id: String
    let name: String
    let description: String?
    let icon: String?
    let dateLabel: String
    let isShared: Bool
    let trustTier: String?
    let signerDisplayName: String?

    /// For local apps: the app store ID used for bundling.
    let localAppId: String?
    /// For shared apps: the UUID used for deletion and re-sharing.
    let sharedUUID: String?
}

struct GeneratedPanel: View {
    var onClose: () -> Void
    let daemonClient: DaemonClient

    @State private var displayItems: [DisplayAppItem] = []
    @State private var isLoading = false
    @State private var hoveredAppId: String?
    @State private var sharingAppId: String?
    @State private var isBundling = false
    @State private var shareFileURL: URL?
    @State private var showShareSheet = false
    @State private var pendingDeleteId: String?

    // Track how many list responses we're waiting for
    @State private var pendingResponses = 0

    init(onClose: @escaping () -> Void, daemonClient: DaemonClient) {
        self.onClose = onClose
        self.daemonClient = daemonClient
    }

    var body: some View {
        VSidePanel(title: "Generated", onClose: onClose) {
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
                    title: "No generated items",
                    subtitle: "Items created by your assistant will appear here",
                    icon: "wand.and.stars"
                )
            } else {
                VStack(spacing: VSpacing.md) {
                    ForEach(displayItems) { item in
                        appRow(item)
                    }
                }
            }
        }
        .onAppear {
            fetchApps()
        }
    }

    // MARK: - App Row

    private func appRow(_ item: DisplayAppItem) -> some View {
        let isHovered = hoveredAppId == item.id
        let isBundlingThis = sharingAppId == item.id && isBundling

        return HStack(spacing: VSpacing.md) {
            // Icon
            Text(item.icon ?? "\u{1F4F1}")
                .font(.system(size: 20))
                .frame(width: 28, height: 28)

            // Name + badges + description
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: VSpacing.xs) {
                    Text(item.name)
                        .font(VFont.bodyBold)
                        .foregroundColor(VColor.textPrimary)
                        .lineLimit(1)

                    if item.isShared {
                        sharedBadge
                    }

                    if let tier = item.trustTier {
                        trustBadge(tier: tier)
                    }
                }

                if let description = item.description, !description.isEmpty {
                    Text(description)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                        .lineLimit(2)
                }

                Text(item.dateLabel)
                    .font(VFont.small)
                    .foregroundColor(VColor.textMuted)
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
                    } else {
                        shareButton(for: item)

                        if item.isShared {
                            deleteButton(for: item)
                        }
                    }
                }
            }
        }
        .padding(VSpacing.lg)
        .background(isHovered ? Slate._800 : Slate._900)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(item.isShared ? Violet._700.opacity(0.4) : Emerald._700.opacity(0.4), lineWidth: 1)
        )
        .onHover { hovering in
            withAnimation(VAnimation.fast) {
                hoveredAppId = hovering ? item.id : nil
            }
        }
    }

    // MARK: - Badges

    private var sharedBadge: some View {
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

    private func trustBadge(tier: String) -> some View {
        let (icon, color): (String, Color) = {
            switch tier {
            case "verified":
                return ("checkmark.seal.fill", VColor.success)
            case "signed":
                return ("checkmark.seal", VColor.textSecondary)
            case "unsigned":
                return ("exclamationmark.triangle.fill", VColor.warning)
            case "tampered":
                return ("xmark.seal.fill", VColor.error)
            default:
                return ("questionmark.circle", VColor.textMuted)
            }
        }()

        return Image(systemName: icon)
            .font(.system(size: 10))
            .foregroundColor(color)
    }

    // MARK: - Buttons

    @ViewBuilder
    private func shareButton(for item: DisplayAppItem) -> some View {
        if let localId = item.localAppId {
            ZStack {
                ShareSheetButton(
                    items: shareFileURL != nil && sharingAppId == item.id ? [shareFileURL!] : [],
                    isPresented: Binding(
                        get: { showShareSheet && sharingAppId == item.id },
                        set: { showShareSheet = $0 }
                    )
                )
                .frame(width: 28, height: 28)

                Button(action: {
                    bundleAndShare(appId: localId, itemId: item.id)
                }) {
                    Image(systemName: "square.and.arrow.up")
                        .font(.system(size: 13))
                        .foregroundColor(Emerald._400)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
            }
        } else if item.isShared, let uuid = item.sharedUUID {
            // Shared apps can be re-shared — reconstruct from unpacked files
            ZStack {
                ShareSheetButton(
                    items: shareFileURL != nil && sharingAppId == item.id ? [shareFileURL!] : [],
                    isPresented: Binding(
                        get: { showShareSheet && sharingAppId == item.id },
                        set: { showShareSheet = $0 }
                    )
                )
                .frame(width: 28, height: 28)

                Button(action: {
                    reshareApp(uuid: uuid, itemId: item.id)
                }) {
                    Image(systemName: "square.and.arrow.up")
                        .font(.system(size: 13))
                        .foregroundColor(Violet._400)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func deleteButton(for item: DisplayAppItem) -> some View {
        Button(action: {
            deleteSharedApp(item)
        }) {
            Image(systemName: "trash")
                .font(.system(size: 12))
                .foregroundColor(Rose._400)
                .frame(width: 24, height: 24)
        }
        .buttonStyle(.plain)
    }

    // MARK: - Data Fetching

    @State private var localApps: [AppItem] = []
    @State private var sharedApps: [SharedAppItem] = []

    @MainActor private func fetchApps() {
        isLoading = true
        pendingResponses = 2

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

        // Handle daemon-side errors that arrive as generic `error` messages
        // instead of typed responses — reset loading/bundling state so the UI
        // never gets permanently stuck.
        daemonClient.onError = { _ in
            if self.isLoading {
                self.pendingResponses -= 1
                if self.pendingResponses <= 0 {
                    self.buildDisplayItems()
                    self.isLoading = false
                }
            }
            if self.isBundling {
                self.isBundling = false
                self.sharingAppId = nil
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

    private func buildDisplayItems() {
        var items: [DisplayAppItem] = []

        // Local apps
        for app in localApps {
            items.append(DisplayAppItem(
                id: "local-\(app.id)",
                name: app.name,
                description: app.description,
                icon: app.icon,
                dateLabel: formatDate(app.createdAt),
                isShared: false,
                trustTier: nil,
                signerDisplayName: nil,
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
                dateLabel: formatISO(app.installedAt),
                isShared: true,
                trustTier: app.trustTier,
                signerDisplayName: app.signerDisplayName,
                localAppId: nil,
                sharedUUID: app.uuid
            ))
        }

        displayItems = items
    }

    // MARK: - Bundle & Share

    @MainActor private func bundleAndShare(appId: String, itemId: String) {
        guard !isBundling else { return }
        sharingAppId = itemId
        isBundling = true

        daemonClient.onBundleAppResponse = { response in
            let url = URL(fileURLWithPath: response.bundlePath)
            self.shareFileURL = url
            self.isBundling = false
            self.showShareSheet = true
        }

        do {
            try daemonClient.sendBundleApp(appId: appId)
        } catch {
            isBundling = false
            sharingAppId = nil
        }
    }

    private func reshareApp(uuid: String, itemId: String) {
        // Share the existing unpacked directory as a folder
        let appDir = BundleSandbox.sharedAppsDirectory.appendingPathComponent(uuid)
        guard FileManager.default.fileExists(atPath: appDir.path) else { return }
        sharingAppId = itemId
        shareFileURL = appDir
        showShareSheet = true
    }

    // MARK: - Delete Shared App

    @MainActor private func deleteSharedApp(_ item: DisplayAppItem) {
        guard let uuid = item.sharedUUID else { return }

        daemonClient.onSharedAppDeleteResponse = { response in
            if response.success {
                self.sharedApps.removeAll { $0.uuid == uuid }
                self.buildDisplayItems()
            }
        }

        do {
            try daemonClient.sendSharedAppDelete(uuid: uuid)
        } catch {
            // Silently fail
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
}

#Preview {
    GeneratedPanel(onClose: {}, daemonClient: DaemonClient())
}
