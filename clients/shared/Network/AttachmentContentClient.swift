import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AttachmentContentClient")

/// Error thrown when the gateway returns a non-2xx status for an attachment
/// content request. Carries the HTTP status so callers can surface a meaningful
/// message (e.g. "Attachment not found") instead of an opaque transport error
/// like `NSURLErrorDomain error -1011`.
public enum AttachmentContentError: LocalizedError {
    case httpStatus(Int)

    public var errorDescription: String? {
        switch self {
        case .httpStatus(404):
            return "Attachment not found"
        case .httpStatus(let status):
            return "Couldn't load attachment (HTTP \(status))"
        }
    }
}

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
    /// - Throws: ``AttachmentContentError`` carrying the HTTP status on a non-2xx
    ///   response, ``GatewayHTTPClient/ClientError``, or network errors.
    public static func fetchContent(attachmentId: String) async throws -> Data {
        let path = "attachments/\(attachmentId)/content"
        let response = try await GatewayHTTPClient.get(path: path, timeout: 120)
        guard response.isSuccess else {
            log.error("Attachment fetch failed with HTTP \(response.statusCode) for \(attachmentId)")
            throw AttachmentContentError.httpStatus(response.statusCode)
        }
        return response.data
    }
}
