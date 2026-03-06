#if os(macOS)
import SwiftUI

/// Rich card shown inline in chat when a new app is created via `app_create`.
/// Displays a preview image, icon + title + description, and action buttons.
/// Background inverts the current color scheme: light mode → dark card, dark mode → light card.
struct InlineAppCreatedCard: View {
    let preview: DynamicPagePreview
    let appId: String?
    let onOpenApp: () -> Void
    var onShareApp: (() -> Void)?

    @Environment(\.colorScheme) private var colorScheme
    @State private var previewImage: String?

    /// Inverse card background: dark in light mode, light in dark mode.
    private var cardBackground: Color {
        colorScheme == .light
            ? Color(red: 0x20/255, green: 0x20/255, blue: 0x1E/255) // #20201E
            : Color(red: 0xF5/255, green: 0xF3/255, blue: 0xEB/255) // #F5F3EB
    }

    /// Text colors that contrast with the inverse background.
    private var cardTextPrimary: Color {
        colorScheme == .light ? .white : .black
    }
    private var cardTextSecondary: Color {
        colorScheme == .light ? Color.white.opacity(0.65) : Color.black.opacity(0.55)
    }

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
                    .foregroundColor(cardTextPrimary)
                    .lineLimit(2)
            }

            if let description = preview.description, !description.isEmpty {
                Text(description)
                    .font(VFont.caption)
                    .foregroundColor(cardTextSecondary)
                    .lineLimit(3)
            }

            // Action buttons
            HStack(spacing: VSpacing.sm) {
                VButton(label: "Open App", leftIcon: "arrow.up.right", style: .primary, size: .small) {
                    onOpenApp()
                }

                Spacer()

                if let onShareApp = onShareApp {
                    Button(action: onShareApp) {
                        Image(systemName: "square.and.arrow.up")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundColor(cardTextSecondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Share app")
                }
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: VRadius.lg).fill(cardBackground))
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .onAppear {
            previewImage = preview.previewImage
            // Fallback request: fires for history-loaded surfaces that didn't go
            // through the eager uiSurfaceShow IPC handler (app restart, reconnect,
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
            onOpenApp: {}
        )
        .frame(width: 400)
        .padding()
    }
    .frame(width: 500, height: 400)
}
#endif
#endif
