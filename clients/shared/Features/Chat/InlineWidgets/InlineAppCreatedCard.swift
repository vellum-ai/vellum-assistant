#if os(macOS)
import SwiftUI

/// Rich card shown inline in chat when a new app is created via `app_create`.
/// Displays a preview image, icon + title + description, and action buttons.
struct InlineAppCreatedCard: View {
    let preview: DynamicPagePreview
    let appId: String?
    let onOpenApp: () -> Void
    let onPinToHomebase: () -> Void

    @State private var previewImage: String?
    @State private var isPinned: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Preview image
            if let base64 = previewImage,
               let data = Data(base64Encoded: base64),
               let nsImage = NSImage(data: data) {
                Image(nsImage: nsImage)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(maxWidth: .infinity)
                    .frame(height: 180)
                    .clipped()
            }

            VStack(alignment: .leading, spacing: VSpacing.md) {
                // Icon + title row
                HStack(spacing: VSpacing.sm) {
                    if let icon = preview.icon {
                        Text(icon)
                            .font(.system(size: 28))
                    }

                    VStack(alignment: .leading, spacing: VSpacing.xxs) {
                        Text(preview.title)
                            .font(VFont.bodyBold)
                            .foregroundColor(VColor.textPrimary)
                            .lineLimit(2)
                    }
                }

                if let description = preview.description, !description.isEmpty {
                    Text(description)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                        .lineLimit(3)
                }

                // Action buttons
                HStack(spacing: VSpacing.sm) {
                    VButton(label: "Open App", leftIcon: "arrow.up.right", style: .primary, size: .small) {
                        onOpenApp()
                    }

                    if isPinned {
                        VButton(label: "Pinned", leftIcon: "checkmark", style: .success, size: .small, isDisabled: true) {}
                    } else {
                        VButton(label: "Pin to Homebase", leftIcon: "pin", style: .outlined, size: .small) {
                            isPinned = true
                            onPinToHomebase()
                        }
                    }
                }
            }
            .padding(VSpacing.lg)
        }
        .background(RoundedRectangle(cornerRadius: VRadius.lg).fill(VColor.surface))
        .overlay(RoundedRectangle(cornerRadius: VRadius.lg).stroke(VColor.surfaceBorder.opacity(0.4), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .onAppear {
            previewImage = preview.previewImage
        }
        .onReceive(NotificationCenter.default.publisher(for: Notification.Name("MainWindow.appPreviewImageCaptured"))) { notification in
            guard let notifAppId = notification.userInfo?["appId"] as? String,
                  notifAppId == appId,
                  let base64 = notification.userInfo?["previewImage"] as? String else { return }
            previewImage = base64
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
            onOpenApp: {},
            onPinToHomebase: {}
        )
        .frame(width: 400)
        .padding()
    }
    .frame(width: 500, height: 400)
}
#endif
#endif
