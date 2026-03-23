import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "MessageClient")

/// Result of uploading a single attachment.
public enum AttachmentUploadResult: Sendable {
    case success(id: String)
    case transientFailure
    case terminalAuthFailure
}

/// Result of sending a message.
public enum MessageSendResult: Sendable {
    /// Message accepted by the server.
    case success(serverConversationId: String?)
    /// Authentication failed terminally (already emitted upstream).
    case authRequired
    /// Message blocked by secret-ingress check.
    case secretBlocked(message: String)
    /// The organization's balance is depleted (HTTP 402).
    case insufficientBalance(detail: String, failedMessageContent: String?)
    /// Generic HTTP or network error.
    case error(statusCode: Int?, message: String, failedMessageContent: String?)
}

/// Focused client for uploading attachments and sending user messages.
@MainActor
public protocol MessageClientProtocol {
    func uploadAttachment(filename: String, mimeType: String, data: String, filePath: String?) async -> AttachmentUploadResult
    func sendMessage(content: String?, conversationKey: String, attachmentIds: [String], conversationType: String?, automated: Bool?, bypassSecretCheck: Bool?) async -> MessageSendResult
}

/// Gateway-backed implementation of ``MessageClientProtocol``.
@MainActor
public struct MessageClient: MessageClientProtocol {
    nonisolated public init() {}

    private static var interfaceValue: String {
        #if os(macOS)
        return "macos"
        #elseif os(iOS)
        return "ios"
        #else
        return "vellum"
        #endif
    }

    public func uploadAttachment(filename: String, mimeType: String, data: String, filePath: String? = nil) async -> AttachmentUploadResult {
        log.info("[send-pipeline] attachment upload start — filename=\(filename, privacy: .public), mimeType=\(mimeType, privacy: .public)")

        var body: [String: Any] = [
            "filename": filename,
            "mimeType": mimeType,
            "data": data
        ]
        if let filePath {
            body["filePath"] = filePath
        }

        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/attachments",
                json: body,
                timeout: 60
            )

            if response.isSuccess {
                let json = try JSONSerialization.jsonObject(with: response.data) as? [String: Any]
                if let id = json?["id"] as? String {
                    log.info("[send-pipeline] attachment upload success — id=\(id, privacy: .public)")
                    return .success(id: id)
                }
                log.error("[send-pipeline] attachment upload response missing id")
                return .transientFailure
            } else if response.statusCode == 401 {
                return .terminalAuthFailure
            } else {
                log.error("[send-pipeline] attachment upload failed (HTTP \(response.statusCode))")
                return .transientFailure
            }
        } catch {
            log.error("[send-pipeline] attachment upload error: \(error.localizedDescription)")
            return .transientFailure
        }
    }

    public func sendMessage(content: String?, conversationKey: String, attachmentIds: [String] = [], conversationType: String? = nil, automated: Bool? = nil, bypassSecretCheck: Bool? = nil) async -> MessageSendResult {
        log.info("[send-pipeline] message request start — uploadedAttachmentIds=\(attachmentIds.count)")

        var body: [String: Any] = [
            "conversationKey": conversationKey,
            "sourceChannel": "vellum",
            "interface": Self.interfaceValue
        ]
        if let content, !content.isEmpty {
            body["content"] = content
        }
        if !attachmentIds.isEmpty {
            body["attachmentIds"] = attachmentIds
        }
        if let conversationType {
            body["conversationType"] = conversationType
        }
        if automated == true {
            body["automated"] = true
        }
        if bypassSecretCheck == true {
            body["bypassSecretCheck"] = true
        }

        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/messages",
                json: body,
                timeout: 30
            )

            if response.isSuccess {
                log.info("Message sent successfully")
                let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any]
                let serverConvId = json?["conversationId"] as? String
                return .success(serverConversationId: serverConvId)
            } else if response.statusCode == 401 {
                return .authRequired
            } else if response.statusCode == 422 {
                let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any]
                if let errorCategory = json?["error"] as? String, errorCategory == "secret_blocked" {
                    let message = (json?["message"] as? String) ?? "Message blocked — contains secrets"
                    log.warning("Message blocked by secret-ingress check")
                    return .secretBlocked(message: message)
                }
                let errorBody = String(data: response.data, encoding: .utf8) ?? "unknown"
                log.error("Send message failed (422): \(errorBody)")
                return .error(statusCode: 422, message: "Failed to send message (HTTP 422)", failedMessageContent: content)
            } else if response.statusCode == 402 {
                let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any]
                let detail = (json?["detail"] as? String) ?? "Insufficient balance. Please add funds to continue."
                log.warning("Send message blocked by billing guard (402)")
                return .insufficientBalance(detail: detail, failedMessageContent: content)
            } else {
                let errorBody = String(data: response.data, encoding: .utf8) ?? "unknown"
                log.error("Send message failed (\(response.statusCode)): \(errorBody)")
                return .error(statusCode: response.statusCode, message: "Failed to send message (HTTP \(response.statusCode))", failedMessageContent: content)
            }
        } catch {
            log.error("Send message error: \(error.localizedDescription)")
            return .error(statusCode: nil, message: error.localizedDescription, failedMessageContent: content)
        }
    }
}
