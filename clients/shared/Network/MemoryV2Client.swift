import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "MemoryV2Client")

/// Per-page summary metadata returned by the memory v2 concept-page list endpoint.
public struct MemoryV2ConceptPageSummary: Codable, Sendable, Equatable, Identifiable {
    public var id: String { slug }
    public let slug: String
    public let bodyBytes: Int
    public let edgeCount: Int
    public let updatedAtMs: Int64

    public init(slug: String, bodyBytes: Int, edgeCount: Int, updatedAtMs: Int64) {
        self.slug = slug
        self.bodyBytes = bodyBytes
        self.edgeCount = edgeCount
        self.updatedAtMs = updatedAtMs
    }
}

/// Response wrapper for the memory v2 concept-page list endpoint.
public struct MemoryV2ListConceptPagesResponse: Codable, Sendable, Equatable {
    public let pages: [MemoryV2ConceptPageSummary]

    public init(pages: [MemoryV2ConceptPageSummary]) {
        self.pages = pages
    }
}

/// Outcome of `listConceptPages()`.
///
/// The `disabled` case lets the UI distinguish "memory v2 is intentionally
/// off in this workspace" (flag-on/config-off, surfaced as HTTP 409
/// `MEMORY_V2_DISABLED`) from a generic transport failure. The Memories
/// panel renders an explicit empty state for `disabled` rather than silently
/// showing zero pages.
public enum MemoryV2ListConceptPagesResult: Sendable, Equatable {
    case success(MemoryV2ListConceptPagesResponse)
    case disabled
    case error
}

/// Focused client for memory v2 concept-page operations routed through the gateway.
///
/// Single-page fetches reuse `LLMContextClient.fetchConceptPage(slug:)` rather
/// than duplicating the endpoint here.
public protocol MemoryV2ClientProtocol: Sendable {
    func listConceptPages() async -> MemoryV2ListConceptPagesResult
}

/// Gateway-backed implementation of ``MemoryV2ClientProtocol``.
public struct MemoryV2Client: MemoryV2ClientProtocol {
    nonisolated public init() {}

    public func listConceptPages() async -> MemoryV2ListConceptPagesResult {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "memory/v2/list-concept-pages",
                json: [:],
                timeout: 15
            )
            if response.isSuccess {
                if let decoded = try? JSONDecoder().decode(MemoryV2ListConceptPagesResponse.self, from: response.data) {
                    return .success(decoded)
                }
                log.error("listConceptPages succeeded but body did not decode")
                return .error
            }
            if response.statusCode == 409, isMemoryV2DisabledError(response.data) {
                return .disabled
            }
            log.error("listConceptPages failed (HTTP \(response.statusCode))")
            return .error
        } catch {
            log.error("listConceptPages failed: \(error.localizedDescription)")
            return .error
        }
    }
}

/// Decode the standard `{ error: { code, message } }` envelope and return
/// `true` when the server signaled that memory v2 is disabled in config.
private func isMemoryV2DisabledError(_ data: Data) -> Bool {
    struct Envelope: Decodable {
        struct Body: Decodable { let code: String? }
        let error: Body?
    }
    return (try? JSONDecoder().decode(Envelope.self, from: data))?.error?.code == "MEMORY_V2_DISABLED"
}
