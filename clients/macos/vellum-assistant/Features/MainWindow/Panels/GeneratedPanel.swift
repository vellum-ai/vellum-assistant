import SwiftUI

struct GeneratedPanel: View {
    var onClose: () -> Void
    let daemonClient: DaemonClient

    @State private var apps: [AppItem] = []
    @State private var isLoading = false
    @State private var hoveredAppId: String?
    @State private var sharingAppId: String?
    @State private var isBundling = false
    @State private var shareFileURL: URL?
    @State private var showShareSheet = false

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
            } else if apps.isEmpty {
                VEmptyState(
                    title: "No generated items",
                    subtitle: "Items created by your assistant will appear here",
                    icon: "wand.and.stars"
                )
            } else {
                VStack(spacing: VSpacing.md) {
                    ForEach(apps) { app in
                        appRow(app)
                    }
                }
            }
        }
        .onAppear {
            fetchApps()
        }
    }

    // MARK: - App Row

    private func appRow(_ app: AppItem) -> some View {
        let isHovered = hoveredAppId == app.id
        let isBundlingThis = sharingAppId == app.id && isBundling

        return HStack(spacing: VSpacing.md) {
            // Icon
            Text(app.icon ?? "\u{1F4F1}")
                .font(.system(size: 20))
                .frame(width: 28, height: 28)

            // Name + description
            VStack(alignment: .leading, spacing: 2) {
                Text(app.name)
                    .font(VFont.bodyBold)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(1)

                if let description = app.description, !description.isEmpty {
                    Text(description)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                        .lineLimit(2)
                }

                Text(formatDate(app.createdAt))
                    .font(VFont.small)
                    .foregroundColor(VColor.textMuted)
            }

            Spacer()

            // Share button — visible on hover
            if isHovered || isBundlingThis {
                if isBundlingThis {
                    ProgressView()
                        .controlSize(.mini)
                        .frame(width: 24, height: 24)
                } else {
                    shareButton(for: app)
                }
            }
        }
        .padding(VSpacing.lg)
        .background(isHovered ? Slate._800 : Slate._900)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(Emerald._700.opacity(0.4), lineWidth: 1)
        )
        .onHover { hovering in
            withAnimation(VAnimation.fast) {
                hoveredAppId = hovering ? app.id : nil
            }
        }
    }

    @ViewBuilder
    private func shareButton(for app: AppItem) -> some View {
        ZStack {
            // Invisible NSViewRepresentable button for NSSharingServicePicker anchor
            ShareSheetButton(
                items: shareFileURL != nil && sharingAppId == app.id ? [shareFileURL!] : [],
                isPresented: Binding(
                    get: { showShareSheet && sharingAppId == app.id },
                    set: { showShareSheet = $0 }
                )
            )
            .frame(width: 28, height: 28)

            // Visible SwiftUI button overlay
            Button(action: {
                bundleAndShare(appId: app.id)
            }) {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 13))
                    .foregroundColor(Emerald._400)
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
        }
    }

    // MARK: - Data Fetching

    private func fetchApps() {
        isLoading = true
        daemonClient.onAppsListResponse = { response in
            self.apps = response.apps
            self.isLoading = false
        }
        do {
            try daemonClient.sendAppsList()
        } catch {
            isLoading = false
        }
    }

    // MARK: - Bundle & Share

    private func bundleAndShare(appId: String) {
        guard !isBundling else { return }
        sharingAppId = appId
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

    // MARK: - Helpers

    private func formatDate(_ epochMs: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(epochMs) / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}

#Preview {
    GeneratedPanel(onClose: {}, daemonClient: DaemonClient())
}
