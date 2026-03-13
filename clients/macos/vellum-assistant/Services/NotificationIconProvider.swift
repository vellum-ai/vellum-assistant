import Foundation
import VellumAssistantShared

/// Protocol for providing notification icon URLs per assistant.
@MainActor
protocol NotificationIconProviding {
    func notificationIconURL(for assistantId: String) -> URL?
}

/// Looks up the pre-exported notification icon PNG on disk.
@MainActor
final class NotificationIconProvider: NotificationIconProviding {
    func notificationIconURL(for assistantId: String) -> URL? {
        let iconURL: URL
        if let assistant = LockfileAssistant.loadByName(assistantId),
           let baseDataDir = assistant.baseDataDir {
            iconURL = URL(fileURLWithPath: baseDataDir)
                .appendingPathComponent("workspace/data/avatar/notification-icon.png")
        } else {
            iconURL = AvatarAppearanceManager.workspaceCustomAvatarURL()
                .deletingLastPathComponent()
                .appendingPathComponent("notification-icon.png")
        }

        guard FileManager.default.fileExists(atPath: iconURL.path) else {
            return nil
        }
        return iconURL
    }
}
