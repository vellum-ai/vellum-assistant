import AppKit
import Foundation
import UserNotifications

/// Caches the rendered notification icon on disk so we don't re-render on every notification.
/// Invalidated when the avatar changes by updating the mod-date check.
private let notificationIconCacheURL: URL = {
    let tmp = FileManager.default.temporaryDirectory
        .appendingPathComponent("com.vellum.vellum-assistant", isDirectory: true)
    try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
    return tmp.appendingPathComponent("notification-icon.png")
}()

/// Tracks the avatar source mod-date so we know when to re-render.
private var cachedAvatarModDate: Date?
/// Tracks the avatar source path so cache invalidates on assistant switch.
private var cachedAvatarPath: String?

extension UNMutableNotificationContent {
    /// Attaches the assistant's avatar (with squircle mask matching the dock icon)
    /// to the notification content. Falls back to the static AppIcon.icns when
    /// no custom avatar is set.
    @MainActor
    func attachAppIcon() {
        // Try custom avatar first
        if let url = avatarNotificationIconURL() {
            // UNNotificationAttachment moves the file, so copy to a unique path per notification.
            let uniqueURL = url.deletingLastPathComponent()
                .appendingPathComponent(UUID().uuidString + ".png")
            if let _ = try? FileManager.default.copyItem(at: url, to: uniqueURL),
               let attachment = try? UNNotificationAttachment(
                identifier: "app-icon",
                url: uniqueURL,
                options: [UNNotificationAttachmentOptionsTypeHintKey: "public.png"]
            ) {
                attachments = [attachment]
                return
            }
        }

        // Fall back to static bundle icon
        guard let iconURL = Bundle.main.url(forResource: "AppIcon", withExtension: "icns")
                ?? Bundle(identifier: "com.vellum.vellum-assistant")?.url(forResource: "AppIcon", withExtension: "icns"),
              let attachment = try? UNNotificationAttachment(identifier: "app-icon", url: iconURL, options: nil)
        else { return }
        attachments = [attachment]
    }

    /// Returns a file URL to the squircle-masked avatar PNG for use as a notification
    /// attachment, or nil if no custom avatar is set.
    @MainActor
    private func avatarNotificationIconURL() -> URL? {
        let manager = AvatarAppearanceManager.shared
        guard let avatar = manager.customAvatarImage else { return nil }

        // Use the assistant-specific resolved path so cache invalidation works
        // correctly after switching assistants.
        let avatarURL = manager.customAvatarURL
        let currentModDate = (try? FileManager.default.attributesOfItem(
            atPath: avatarURL.path))?[.modificationDate] as? Date

        // Cache on both resolved avatar path AND mod-date to prevent collisions
        // when two assistants have avatar files with the same modification timestamp.
        if FileManager.default.fileExists(atPath: notificationIconCacheURL.path),
           let currentModDate, let cachedDate = cachedAvatarModDate,
           currentModDate == cachedDate,
           avatarURL.path == cachedAvatarPath {
            return notificationIconCacheURL
        }

        let size: CGFloat = 256
        let icon = AvatarAppearanceManager.squircleIcon(avatar, size: size)

        // Render directly into a 2x bitmap — no TIFF intermediate.
        let px = Int(size) * 2
        guard let bitmap = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ) else { return nil }
        bitmap.size = NSSize(width: size, height: size)

        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
        icon.draw(in: NSRect(origin: .zero, size: NSSize(width: size, height: size)),
                  from: .zero, operation: .copy, fraction: 1.0)
        NSGraphicsContext.restoreGraphicsState()

        guard let pngData = bitmap.representation(using: .png, properties: [:]) else { return nil }

        do {
            try pngData.write(to: notificationIconCacheURL)
            cachedAvatarModDate = currentModDate
            cachedAvatarPath = avatarURL.path
            return notificationIconCacheURL
        } catch {
            return nil
        }
    }
}
