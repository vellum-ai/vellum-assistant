#if os(macOS)
import SwiftUI

/// Rich card shown inline in chat when a new app is created via `app_create`.
/// Wraps the shared `VAppCard` and adds the preview-capture + pin-state
/// plumbing specific to the app-builder flow.
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
        VAppCard(
            title: preview.title,
            description: preview.description ?? preview.subtitle,
            icon: VAppIconGenerator.generate(from: preview.title, type: appId),
            isPinned: isPinned,
            isOpenDisabled: !isToolCallComplete,
            pinLabel: "Pin to Nav",
            onOpen: onOpenApp,
            onPin: onTogglePin.map { handler in
                { handler(isPinned) }
            }
        ) {
            if let base64 = previewImage,
               let data = Data(base64Encoded: base64),
               let nsImage = NSImage(data: data) {
                Image(nsImage: nsImage)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else {
                VColor.surfaceActive
            }
        }
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
}
#endif
