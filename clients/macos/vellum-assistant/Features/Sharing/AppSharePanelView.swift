import AppKit
import SwiftUI
import VellumAssistantShared

/// Custom share panel that replaces NSSharingServicePicker, showing the app icon
/// prominently in the header instead of a blank document icon.
struct AppSharePanelView: View {
    let fileURL: URL
    let appName: String
    let appIcon: NSImage?
    let appId: String?
    let gatewayBaseURL: String
    let onDismiss: () -> Void

    @State private var services: [NSSharingService] = []
    @State private var hoveredServiceIndex: Int?
    @State private var showChannelPicker = false
    @State private var isSendingToSlack = false
    @State private var slackError: String?
    @State private var formattedFileSize: String = ""

    @available(macOS, deprecated: 13.0)
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if showChannelPicker {
                channelPickerView
            } else {
                servicesListView
            }
        }
        .frame(width: 240)
        .onDisappear {
            if hoveredServiceIndex != nil {
                NSCursor.pop()
                hoveredServiceIndex = nil
            }
        }
        .background(VColor.surfaceSubtle)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.15), radius: 6, y: 2)
        .onAppear {
            services = Self.availableSharingServices(for: fileURL)
        }
        .task {
            formattedFileSize = await computeFileSize()
        }
    }

    // MARK: - Services List

    @available(macOS, deprecated: 13.0)
    private var servicesListView: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header: app icon, name, file size
            header
                .padding(VSpacing.lg)

            VColor.surfaceBorder.frame(height: 1)

            // Services list
            ScrollView {
                VStack(spacing: 0) {
                    // Slack row — only enabled when appId is available
                    if appId != nil {
                        serviceRow(
                            icon: NSWorkspace.shared.icon(forFile: "/Applications/Slack.app"),
                            title: "Slack",
                            index: -2
                        ) {
                            handleSlackShare()
                        }
                    } else {
                        disabledSlackRow
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

                    VColor.surfaceBorder.frame(height: 1)
                        .padding(.horizontal, VSpacing.xs)
                        .padding(.vertical, VSpacing.xs)

                    // Copy row
                    serviceRow(
                        icon: VIcon.copy.nsImage,
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
    }

    // MARK: - Channel Picker

    private var channelPickerView: some View {
        VStack(alignment: .leading, spacing: 0) {
            if isSendingToSlack {
                VStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Sending...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
                .frame(maxWidth: .infinity)
                .frame(width: 240)
                .padding(.vertical, VSpacing.xxl)
            } else if let error = slackError {
                VStack(spacing: VSpacing.sm) {
                    Text(error)
                        .font(VFont.caption)
                        .foregroundColor(VColor.error)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, VSpacing.md)

                    HStack(spacing: VSpacing.md) {
                        Button("Back") {
                            slackError = nil
                            showChannelPicker = false
                        }
                        .buttonStyle(.plain)
                        .font(VFont.captionMedium)
                        .foregroundColor(VColor.textSecondary)

                        Button("Retry") {
                            slackError = nil
                        }
                        .buttonStyle(.plain)
                        .font(VFont.captionMedium)
                        .foregroundColor(VColor.accent)
                    }
                }
                .frame(maxWidth: .infinity)
                .frame(width: 240)
                .padding(.vertical, VSpacing.xxl)
            } else {
                SlackChannelPickerView(
                    gatewayBaseURL: gatewayBaseURL,
                    onSelect: { channel in
                        shareToChannel(channel)
                    },
                    onCancel: {
                        showChannelPicker = false
                    }
                )
            }
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
            HStack(spacing: VSpacing.sm) {
                if let icon {
                    Image(nsImage: icon)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 18, height: 18)
                } else {
                    Color.clear.frame(width: 18, height: 18)
                }

                Text(title)
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)

                Spacer()
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .background(hoveredServiceIndex == index ? VColor.navHover : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            hoveredServiceIndex = hovering ? index : nil
            if hovering { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
    }

    // MARK: - Disabled Slack Row

    private var disabledSlackRow: some View {
        HStack(spacing: VSpacing.sm) {
            Image(nsImage: NSWorkspace.shared.icon(forFile: "/Applications/Slack.app"))
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 18, height: 18)
                .opacity(0.5)

            VStack(alignment: .leading, spacing: 1) {
                Text("Slack")
                    .font(VFont.body)
                    .foregroundColor(VColor.textMuted)

                Text("Unavailable for this app")
                    .font(VFont.small)
                    .foregroundColor(VColor.textMuted)
            }

            Spacer()
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.sm)
    }

    // MARK: - Helpers

    /// Queries available sharing services. The API was deprecated in macOS 13 in favor of
    /// NSSharingServicePicker.standardShareMenuItem, but the replacement doesn't expose
    /// individual services for custom UI. No functional replacement exists.
    @available(macOS, deprecated: 13.0)
    private static func availableSharingServices(for url: URL) -> [NSSharingService] {
        NSSharingService.sharingServices(forItems: [url])
    }

    private func computeFileSize() async -> String {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: fileURL.path, isDirectory: &isDirectory) else {
            return ""
        }
        if isDirectory.boolValue {
            let url = fileURL
            let size = await Task.detached {
                Self.directorySize(at: url)
            }.value
            return size
                .map { ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file) }
                ?? "App Bundle"
        }
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: fileURL.path),
              let size = attrs[.size] as? UInt64 else {
            return ""
        }
        return ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)
    }

    /// Recursively computes the total size of all files within a directory.
    nonisolated private static func directorySize(at url: URL) -> UInt64? {
        guard let enumerator = FileManager.default.enumerator(
            at: url,
            includingPropertiesForKeys: [.fileSizeKey, .isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else {
            return nil
        }
        var total: UInt64 = 0
        for case let fileURL as URL in enumerator {
            guard let resourceValues = try? fileURL.resourceValues(forKeys: [.fileSizeKey, .isDirectoryKey]),
                  resourceValues.isDirectory != true,
                  let fileSize = resourceValues.fileSize else {
                continue
            }
            total += UInt64(fileSize)
        }
        return total
    }

    private func handleSlackShare() {
        showChannelPicker = true
    }

    private func shareToChannel(_ channel: SlackChannel) {
        guard !isSendingToSlack, let appId else { return }
        isSendingToSlack = true
        slackError = nil

        Task {
            do {
                guard let url = URL(string: "\(gatewayBaseURL)/v1/slack/share") else {
                    isSendingToSlack = false
                    slackError = "Invalid gateway URL"
                    return
                }

                var request = URLRequest(url: url)
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")

                if let token = ActorTokenManager.getToken(), !token.isEmpty {
                    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                }

                let body: [String: String] = ["appId": appId, "channelId": channel.id]
                request.httpBody = try JSONEncoder().encode(body)

                let (_, response) = try await URLSession.shared.data(for: request)

                guard let httpResponse = response as? HTTPURLResponse else {
                    isSendingToSlack = false
                    slackError = "Unexpected response"
                    return
                }

                guard (200...299).contains(httpResponse.statusCode) else {
                    isSendingToSlack = false
                    slackError = "Failed to share (\(httpResponse.statusCode))"
                    return
                }

                isSendingToSlack = false
                onDismiss()
            } catch is CancellationError {
                isSendingToSlack = false
            } catch {
                isSendingToSlack = false
                slackError = "Failed to share to Slack"
            }
        }
    }
}
