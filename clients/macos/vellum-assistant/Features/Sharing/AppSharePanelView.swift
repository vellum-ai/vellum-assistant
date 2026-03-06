import AppKit
import SwiftUI
import VellumAssistantShared

/// Custom share panel that replaces NSSharingServicePicker, showing the app icon
/// prominently in the header instead of a blank document icon.
struct AppSharePanelView: View {
    let fileURL: URL
    let appName: String
    let appIcon: NSImage?
    let onDismiss: () -> Void

    @State private var services: [NSSharingService] = []
    @State private var hoveredServiceIndex: Int?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header: app icon, name, file size
            header
                .padding(VSpacing.lg)

            Divider()
                .background(VColor.surfaceBorder)

            // Services list
            ScrollView {
                VStack(spacing: 0) {
                    // Slack row
                    serviceRow(
                        icon: NSWorkspace.shared.icon(forFile: "/Applications/Slack.app"),
                        title: "Slack",
                        index: -2
                    ) {
                        handleSlackShare()
                    }

                    // System sharing services
                    ForEach(Array(services.enumerated()), id: \.offset) { index, service in
                        serviceRow(
                            icon: service.image,
                            title: service.title,
                            index: index
                        ) {
                            service.perform(withItems: [fileURL])
                            onDismiss()
                        }
                    }

                    Divider()
                        .background(VColor.surfaceBorder)
                        .padding(.vertical, VSpacing.xs)

                    // Copy row
                    serviceRow(
                        icon: NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: "Copy"),
                        title: "Copy",
                        index: -1
                    ) {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.writeObjects([fileURL as NSURL])
                        onDismiss()
                    }
                }
                .padding(.vertical, VSpacing.xs)
            }
            .frame(maxHeight: 300)
        }
        .frame(width: 240)
        .background(VColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .onAppear {
            services = Self.availableSharingServices(for: fileURL)
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: VSpacing.md) {
            // App icon at 64x64
            Group {
                if let icon = appIcon {
                    Image(nsImage: icon)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                } else {
                    // Fallback: first letter of app name
                    ZStack {
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .fill(VColor.backgroundSubtle)
                        Text(String(appName.prefix(1)).uppercased())
                            .font(.system(size: 28, weight: .bold))
                            .foregroundColor(VColor.textSecondary)
                    }
                }
            }
            .frame(width: 64, height: 64)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text(appName)
                    .font(VFont.headline)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(2)

                Text(formattedFileSize)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
            }
        }
    }

    // MARK: - Service Row

    private func serviceRow(
        icon: NSImage?,
        title: String,
        index: Int,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: VSpacing.md) {
                if let icon {
                    Image(nsImage: icon)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 20, height: 20)
                } else {
                    Color.clear.frame(width: 20, height: 20)
                }

                Text(title)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)

                Spacer()
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .background(hoveredServiceIndex == index ? VColor.backgroundSubtle : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            hoveredServiceIndex = hovering ? index : nil
        }
    }

    // MARK: - Helpers

    /// Queries available sharing services. The API was deprecated in macOS 13 in favor of
    /// NSSharingServicePicker.standardShareMenuItem, but the replacement doesn't expose
    /// individual services for custom UI. No functional replacement exists.
    @available(macOS, deprecated: 13.0)
    private static func availableSharingServices(for url: URL) -> [NSSharingService] {
        NSSharingService.sharingServices(forItems: [url])
    }

    private var formattedFileSize: String {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: fileURL.path),
              let size = attrs[.size] as? UInt64 else {
            return ""
        }
        return ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)
    }

    private func handleSlackShare() {
        let downloadsURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first!
        let destinationURL = downloadsURL.appendingPathComponent(fileURL.lastPathComponent)

        if fileURL.standardizedFileURL != destinationURL.standardizedFileURL {
            try? FileManager.default.removeItem(at: destinationURL)
            try? FileManager.default.copyItem(at: fileURL, to: destinationURL)
        }

        if let slackURL = URL(string: "slack://") {
            NSWorkspace.shared.open(slackURL)
        }

        NSWorkspace.shared.activateFileViewerSelecting([destinationURL])
        onDismiss()
    }
}
