import Foundation
import VellumAssistantShared

/// A single message within an inbox thread.
struct InboxMessage: Identifiable {
    let id: String
    let role: String
    let content: String
    let createdAt: Date?

    init(from ipcMessage: IPCAssistantInboxResponseMessage) {
        self.id = ipcMessage.id
        self.role = ipcMessage.role
        self.content = ipcMessage.content
        self.createdAt = Date(timeIntervalSince1970: Double(ipcMessage.createdAt) / 1000.0)
    }
}

/// A single inbox thread for display in the assistant inbox panel.
struct InboxThread: Identifiable {
    let id: String
    let conversationId: String
    let sourceChannel: String
    let externalChatId: String
    let displayName: String?
    let username: String?
    let lastMessageAt: Date?
    let unreadCount: Int
    let hasPendingEscalation: Bool

    init(from ipcThread: IPCAssistantInboxResponseThread) {
        self.id = ipcThread.conversationId
        self.conversationId = ipcThread.conversationId
        self.sourceChannel = ipcThread.sourceChannel
        self.externalChatId = ipcThread.externalChatId
        self.displayName = ipcThread.displayName
        self.username = ipcThread.username
        self.unreadCount = ipcThread.unreadCount
        self.hasPendingEscalation = ipcThread.hasPendingEscalation

        if let timestamp = ipcThread.lastMessageAt {
            self.lastMessageAt = Date(timeIntervalSince1970: Double(timestamp) / 1000.0)
        } else {
            self.lastMessageAt = nil
        }
    }

    /// Human-readable name for this thread, falling back through display name, username, and chat ID.
    var resolvedName: String {
        displayName ?? username ?? externalChatId
    }

    /// SF Symbol name for the source channel icon.
    var channelIcon: String {
        switch sourceChannel.lowercased() {
        case "telegram":
            return "paperplane.fill"
        case "sms", "twilio":
            return "message.fill"
        case "email":
            return "envelope.fill"
        case "web":
            return "globe"
        default:
            return "bubble.left.fill"
        }
    }
}

@MainActor
final class InboxViewModel: ObservableObject {
    @Published var threads: [InboxThread] = []
    @Published var isLoading: Bool = false
    @Published var error: String?

    @Published var messages: [InboxMessage] = []
    @Published var isLoadingMessages: Bool = false
    @Published var messagesError: String?
    @Published var isSendingReply: Bool = false
    @Published var sendReplyError: String?

    private let daemonClient: DaemonClient

    init(daemonClient: DaemonClient) {
        self.daemonClient = daemonClient
    }

    func loadThreads() async {
        isLoading = true
        error = nil

        let stream = daemonClient.subscribe()

        do {
            try daemonClient.sendAssistantInboxListThreads()
        } catch {
            self.error = error.localizedDescription
            self.isLoading = false
            return
        }

        // Wait for the response with a timeout
        let response: IPCAssistantInboxResponse? = await withTaskGroup(of: IPCAssistantInboxResponse?.self) { group in
            group.addTask {
                for await message in stream {
                    if case .assistantInboxResponse(let msg) = message {
                        return msg
                    }
                }
                return nil
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }

        isLoading = false

        guard let response else {
            self.error = "Request timed out"
            return
        }

        if !response.success {
            self.error = response.error ?? "Unknown error"
            return
        }

        self.threads = (response.threads ?? []).map { InboxThread(from: $0) }
    }

    func loadMessages(conversationId: String) async {
        isLoadingMessages = true
        messagesError = nil
        messages = []

        let stream = daemonClient.subscribe()

        do {
            try daemonClient.sendAssistantInboxGetThreadMessages(conversationId: conversationId)
        } catch {
            self.messagesError = error.localizedDescription
            self.isLoadingMessages = false
            return
        }

        let response: IPCAssistantInboxResponse? = await withTaskGroup(of: IPCAssistantInboxResponse?.self) { group in
            group.addTask {
                for await message in stream {
                    if case .assistantInboxResponse(let msg) = message {
                        return msg
                    }
                }
                return nil
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }

        isLoadingMessages = false

        guard let response else {
            self.messagesError = "Request timed out"
            return
        }

        if !response.success {
            self.messagesError = response.error ?? "Unknown error"
            return
        }

        self.messages = (response.messages ?? []).map { InboxMessage(from: $0) }
    }

    /// Send a reply to a conversation and reload messages on success.
    func sendReply(conversationId: String, content: String) async -> Bool {
        isSendingReply = true
        sendReplyError = nil

        let stream = daemonClient.subscribe()

        do {
            try daemonClient.sendAssistantInboxReply(conversationId: conversationId, content: content)
        } catch {
            self.sendReplyError = error.localizedDescription
            self.isSendingReply = false
            return false
        }

        let response: IPCAssistantInboxReplyResponse? = await withTaskGroup(of: IPCAssistantInboxReplyResponse?.self) { group in
            group.addTask {
                for await message in stream {
                    if case .assistantInboxReplyResponse(let msg) = message {
                        return msg
                    }
                }
                return nil
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: 10_000_000_000)
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }

        isSendingReply = false

        guard let response else {
            self.sendReplyError = "Request timed out"
            return false
        }

        if !response.success {
            self.sendReplyError = response.error ?? "Unknown error"
            return false
        }

        // Reload messages to show the new reply
        await loadMessages(conversationId: conversationId)
        return true
    }
}
