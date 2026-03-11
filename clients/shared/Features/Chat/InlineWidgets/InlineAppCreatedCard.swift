#if os(macOS)
import SwiftUI

/// Rich card shown inline in chat when a new app is created via `app_create`.
/// Displays a preview image, icon + title + description, and action buttons.
struct InlineAppCreatedCard: View {
    let preview: DynamicPagePreview
    let appId: String?
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
                    .frame(maxWidth: .infinity)
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
                    .font(VFont.bodyBold)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(2)
            }

            if let description = preview.description, !description.isEmpty {
                Text(description)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .lineLimit(3)
            }

            // Action buttons
            HStack(spacing: VSpacing.sm) {
                VButton(label: "Open App", leftIcon: VIcon.arrowUpRight.rawValue, style: .primary, size: .small) {
                    onOpenApp()
                }

                if let onTogglePin = onTogglePin {
                    VButton(
                        label: isPinned ? "Unpin" : "Pin to Nav",
                        leftIcon: isPinned ? VIcon.pinOff.rawValue : VIcon.pin.rawValue,
                        style: .tertiary,
                        size: .small
                    ) {
                        onTogglePin(isPinned)
                    }
                }

                Spacer()
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: VRadius.lg).fill(VColor.appCardBackground))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .onAppear {
            previewImage = preview.previewImage
            // Fallback request: fires for history-loaded surfaces that didn't go
            // through the eager uiSurfaceShow handler (app restart, reconnect,
            // thread switch). For live surfaces the eager request in
            // ChatViewModel+MessageHandling may have already fired; the duplicate
            // is harmless since the daemon treats preview requests idempotently.
            if previewImage == nil, let appId = appId {
                NotificationCenter.default.post(
                    name: Notification.Name("MainWindow.requestAppPreview"),
                    object: nil,
                    userInfo: ["appId": appId]
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
}

#if DEBUG
#Preview("InlineAppCreatedCard") {
    ZStack {
        VColor.background.ignoresSafeArea()
        InlineAppCreatedCard(
            preview: DynamicPagePreview(
                title: "Kanban Board",
                description: "Here's a simple dashboard with drag-and-drop task management.",
                icon: "🎯"
            ),
            appId: "test-app-id",
            onOpenApp: {}
        )
        .frame(width: 400)
        .padding()
    }
    .frame(width: 500, height: 400)
}
#endif
#endif
