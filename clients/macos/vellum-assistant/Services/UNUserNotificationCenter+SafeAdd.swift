import Foundation
import UserNotifications

extension UNUserNotificationCenter {
    /// Posts a notification request using the completion handler API, resuming
    /// on the main dispatch queue to avoid the background-thread executor hop
    /// that the auto-generated `async` bridge performs.
    ///
    /// Apple's completion handler for `add(_:withCompletionHandler:)` may execute
    /// on a background thread. The auto-generated Swift async bridge resumes its
    /// internal continuation on that background queue, which can trigger
    /// use-after-free crashes when the caller is `@MainActor`-isolated.
    ///
    /// - Parameter request: The notification request to post.
    /// - Returns: The error from the notification center, or `nil` on success.
    func safeAdd(_ request: UNNotificationRequest) async -> Error? {
        await withCheckedContinuation { continuation in
            self.add(request) { error in
                DispatchQueue.main.async {
                    continuation.resume(returning: error)
                }
            }
        }
    }
}
