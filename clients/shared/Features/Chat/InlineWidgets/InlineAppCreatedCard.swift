#if os(macOS)
import SwiftUI

/// Rich card shown inline in chat when a new app is created via `app_create`.
/// Displays a preview image, icon + title + description, metrics, and action buttons.
struct InlineAppCreatedCard: View {
    let preview: DynamicPagePreview
    let appId: String?
    /// Raw HTML for offscreen preview capture fallback (history-loaded surfaces).
    let html: String?
    /// Whether the parent tool call has finished. When `false`, the "Open App"
    /// button is disabled so the user can't navigate to partially-written HTML.
    let isToolCallComplete: Bool
    let onOpenApp: () -> Void
    var onTogglePin: ((_ isPinned: Bool) -> Void)?
    @State private var previewImage: String?
    @State private var isPinned: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            // Preview image
            if let base64 = previewImage,
               let data = Data(base64Encoded: base64),
               let nsImage = NSImage(data: data) {
                Image(nsImage: nsImage)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(height: 140)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            }

            // Icon + title row
            HStack(spacing: VSpacing.sm) {
                if let icon = preview.icon {
                    Text(icon)
                        .font(.system(size: 14))
                }

                Text(preview.title)
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(2)
            }

            if let description = preview.description, !description.isEmpty {
                Text(description)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .lineLimit(3)
            }

            if let metrics = preview.metrics, !metrics.isEmpty {
                HStack(spacing: VSpacing.sm) {
                    ForEach(Array(metrics.prefix(3).enumerated()), id: \.offset) { _, metric in
                        metricPill(label: metric.label, value: metric.value)
                    }
                }
            }

            // Action buttons
            HStack(spacing: VSpacing.sm) {
                VButton(label: "Open App", leftIcon: VIcon.arrowUpRight.rawValue, style: .primary, isDisabled: !isToolCallComplete) {
                    onOpenApp()
                }

                if let onTogglePin = onTogglePin {
                    VButton(
                        label: isPinned ? "Unpin" : "Pin to Nav",
                        leftIcon: isPinned ? VIcon.pinOff.rawValue : VIcon.pin.rawValue,
                        style: .outlined
                    ) {
                        onTogglePin(isPinned)
                    }
                }

                Spacer()
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: VRadius.lg).fill(VColor.surfaceOverlay))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .onAppear {
            previewImage = preview.previewImage
            // Fallback request: fires ONLY for history-loaded surfaces where the
            // build already completed (isToolCallComplete == true). These didn't
            // go through handleToolResult (app restart, reconnect, conversation
            // switch) so they need an explicit capture request.
            //
            // For live surfaces (isToolCallComplete == false), we do NOT request
            // a preview here — the build hasn't finished yet and the daemon would
            // return blank/incomplete HTML. The single authoritative capture will
            // come from handleToolResult once the build completes.
            if previewImage == nil, isToolCallComplete, let appId = appId {
                var userInfo: [String: Any] = ["appId": appId]
                if let html = html {
                    userInfo["html"] = html
                }
                NotificationCenter.default.post(
                    name: Notification.Name("MainWindow.requestAppPreview"),
                    object: nil,
                    userInfo: userInfo
                )
            }
            // Query initial pin state
            if let appId = appId {
                NotificationCenter.default.post(
                    name: Notification.Name("MainWindow.queryAppPinState"),
                    object: nil,
                    userInfo: ["appId": appId]
                )
            }
        }
        .onChange(of: isToolCallComplete) { oldValue, newValue in
            // Build just completed — request the authoritative post-build preview.
            // This is the primary trigger for live surfaces; the onAppear fallback
            // above only handles history-loaded surfaces where the build already
            // finished before the view appeared.
            if newValue && !oldValue, previewImage == nil, let appId = appId {
                var userInfo: [String: Any] = ["appId": appId]
                if let html = html { userInfo["html"] = html }
                userInfo["forceRecapture"] = true
                NotificationCenter.default.post(
                    name: Notification.Name("MainWindow.requestAppPreview"),
                    object: nil,
                    userInfo: userInfo
                )
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("MainWindow.appPreviewImageCaptured"))) { notification in
            guard let notifAppId = notification.userInfo?["appId"] as? String,
                  notifAppId == appId,
                  let base64 = notification.userInfo?["previewImage"] as? String else { return }
            previewImage = base64
        }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("MainWindow.appPinStateChanged"))) { notification in
            guard let notifAppId = notification.userInfo?["appId"] as? String,
                  notifAppId == appId,
                  let pinned = notification.userInfo?["isPinned"] as? Bool else { return }
            isPinned = pinned
        }
    }

    private func metricPill(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            Text(label)
                .font(VFont.labelSmall)
                .foregroundStyle(VColor.contentTertiary)
            Text(value)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(1)
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
    }
}
#endif
