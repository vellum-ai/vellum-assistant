import AppKit
import VellumAssistantShared
import SwiftUI

/// Standalone window that displays the task queue independently of the main window.
/// Follows the same pattern as ComponentGalleryWindow and OnboardingWindow.
@MainActor
final class TasksWindow {
    private var window: NSWindow?
    private let daemonClient: DaemonClient
    private weak var threadManager: ThreadManager?

    init(daemonClient: DaemonClient, threadManager: ThreadManager? = nil) {
        self.daemonClient = daemonClient
        self.threadManager = threadManager
    }

    func show() {
        if let existing = window {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            // Force a data refresh so the view doesn't show stale items
            try? daemonClient.sendWorkItemsList()
            return
        }

        let onRunTaskInChat: ((String, String, String) -> Bool)? = { [weak self] workItemId, content, title in
            self?.routeTaskToChat(workItemId: workItemId, content: content, title: title) ?? false
        }

        let hostingController = NSHostingController(
            rootView: TasksWindowView(daemonClient: daemonClient, onRunTaskInChat: onRunTaskInChat)
        )

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 550),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )

        window.contentViewController = hostingController
        window.title = "Tasks"
        window.backgroundColor = NSColor(VColor.background)
        window.isReleasedWhenClosed = false
        window.contentMinSize = NSSize(width: 320, height: 400)

        window.setContentSize(NSSize(width: 420, height: 550))
        window.center()

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        self.window = window
    }

    var isVisible: Bool {
        window?.isVisible ?? false
    }

    func close() {
        window?.close()
        window = nil
    }

    /// Inject the rendered task content as a user message into the active chat thread.
    /// After the message is sent, the work item status will be updated to awaiting_review
    /// when the assistant finishes processing the message.
    /// Returns true if the message was successfully injected.
    private func routeTaskToChat(workItemId: String, content: String, title: String) -> Bool {
        guard let threadManager = threadManager else { return false }

        // Get or create the active ChatViewModel
        guard let chatVM = threadManager.activeViewModel else { return false }

        // Prefix the task content so the user can see it came from a task
        let taskMessage = "[Task: \(title)]\n\n\(content)"

        // Set the input text and send it as a normal user message
        chatVM.inputText = taskMessage
        chatVM.sendMessage()

        // Bring the main window to the foreground so the user can see progress
        (NSApp.delegate as? AppDelegate)?.showMainWindow()

        // Track the work item ID so we can update status when chat completes.
        // The ChatViewModel's onToolCallsComplete or message_complete event
        // will eventually fire. We use a simple observation of isSending
        // transitioning back to false to mark the work item as awaiting_review.
        observeChatCompletion(workItemId: workItemId, chatVM: chatVM)

        return true
    }

    /// Watch for the chat session to finish processing (isSending -> false)
    /// and then update the work item status to awaiting_review.
    private func observeChatCompletion(workItemId: String, chatVM: ChatViewModel) {
        Task { @MainActor [weak self, weak chatVM] in
            guard let chatVM else { return }

            // Poll until the chat finishes sending. This is simpler than
            // wiring up a Combine subscriber for a one-shot observation.
            while chatVM.isSending {
                try? await Task.sleep(nanoseconds: 500_000_000) // 500ms
            }

            // Update the work item status to awaiting_review now that
            // the assistant has finished processing the task message.
            guard self != nil else { return }
            do {
                try self?.daemonClient.sendWorkItemUpdate(id: workItemId, status: "awaiting_review")
            } catch {
                // Status update is best-effort — the task was already
                // processed in chat, so the user saw the results.
            }
        }
    }
}
