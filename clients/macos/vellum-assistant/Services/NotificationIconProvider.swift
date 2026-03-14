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
        guard !assistantId.isEmpty else { return nil }

        let iconURL: URL
        if let assistant = LockfileAssistant.loadByName(assistantId),
           let baseDataDir = assistant.baseDataDir {
            iconURL = URL(fileURLWithPath: baseDataDir)
                .appendingPathComponent("workspace/data/avatar/notification-icon-\(assistantId).png")
        } else {
            // Fall back to default workspace path with assistant-scoped filename
            iconURL = AvatarAppearanceManager.workspaceCustomAvatarURL()
                .deletingLastPathComponent()
                .appendingPathComponent("notification-icon-\(assistantId).png")
        }

        guard FileManager.default.fileExists(atPath: iconURL.path) else {
            return nil
        }
        return iconURL
    }
}
