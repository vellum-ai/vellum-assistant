import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AttachmentContentClient")

/// Fetches raw attachment bytes via the gateway, supporting both local and
/// managed (platform-hosted) assistants through ``GatewayHTTPClient``.
public enum AttachmentContentClient {

    /// Fetches the raw binary content for the given attachment ID.
    ///
    /// Routes through ``GatewayHTTPClient`` so managed assistants use the
    /// platform proxy with session-token auth while local assistants hit
    /// the local gateway with bearer-token auth.
    ///
    /// - Parameter attachmentId: The unique identifier of the attachment.
    /// - Returns: The raw attachment bytes.
    /// - Throws: ``GatewayHTTPClient/ClientError`` or network errors.
    public static func fetchContent(attachmentId: String) async throws -> Data {
        let path = "assistants/{assistantId}/attachments/\(attachmentId)/content"
        let response = try await GatewayHTTPClient.get(path: path, timeout: 120)
        guard response.isSuccess else {
            log.error("Attachment fetch failed with HTTP \(response.statusCode) for \(attachmentId)")
            throw URLError(.badServerResponse)
        }
        return response.data
    }
}
