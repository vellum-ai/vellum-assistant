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

/// Focused client for memory v2 concept-page operations routed through the gateway.
///
/// Single-page fetches reuse `LLMContextClient.fetchConceptPage(slug:)` rather
/// than duplicating the endpoint here.
public protocol MemoryV2ClientProtocol: Sendable {
    func listConceptPages() async -> MemoryV2ListConceptPagesResponse?
}

/// Gateway-backed implementation of ``MemoryV2ClientProtocol``.
public struct MemoryV2Client: MemoryV2ClientProtocol {
    nonisolated public init() {}

    public func listConceptPages() async -> MemoryV2ListConceptPagesResponse? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "memory/v2/list-concept-pages",
                json: [:],
                timeout: 15
            )
            guard response.isSuccess else {
                log.error("listConceptPages failed (HTTP \(response.statusCode))")
                return nil
            }
            return try? JSONDecoder().decode(MemoryV2ListConceptPagesResponse.self, from: response.data)
        } catch {
            log.error("listConceptPages failed: \(error.localizedDescription)")
            return nil
        }
    }
}
