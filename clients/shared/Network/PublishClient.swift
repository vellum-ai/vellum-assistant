import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "PublishClient")

/// Focused client for page publishing and link-open operations routed through the gateway.
@MainActor
public protocol PublishClientProtocol {
    func publishPage(html: String, title: String?, appId: String?) async throws -> PublishPageResponseMessage?
    func openLink(url: String, metadata: [String: AnyCodable]?) async throws -> Bool
}

/// Gateway-backed implementation of ``PublishClientProtocol``.
@MainActor
public struct PublishClient: PublishClientProtocol {
    nonisolated public init() {}

    public func publishPage(html: String, title: String? = nil, appId: String? = nil) async throws -> PublishPageResponseMessage? {
        var body: [String: Any] = ["type": "publish_page", "html": html]
        if let title { body["title"] = title }
        if let appId { body["appId"] = appId }

        let response = try await GatewayHTTPClient.post(
            path: "assistants/{assistantId}/publish", json: body, timeout: 30
        )
        guard response.isSuccess else {
            log.error("publishPage failed (HTTP \(response.statusCode))")
            return nil
        }
        let patched = injectType("publish_page_response", into: response.data)
        return try JSONDecoder().decode(PublishPageResponseMessage.self, from: patched)
    }

    public func openLink(url: String, metadata: [String: AnyCodable]? = nil) async throws -> Bool {
        var body: [String: Any] = ["type": "link_open_request", "url": url]
        if let metadata {
            body["metadata"] = metadata.mapValues { $0.value }
        }

        let response = try await GatewayHTTPClient.post(
            path: "assistants/{assistantId}/link/open", json: body, timeout: 10
        )
        guard response.isSuccess else {
            log.error("openLink failed (HTTP \(response.statusCode))")
            return false
        }
        return true
    }

    // MARK: - Helpers

    /// Injects the `"type"` discriminant required by `Codable` decoding of
    /// server message types whose JSON payloads omit it over HTTP.
    private func injectType(_ type: String, into data: Data) -> Data {
        guard var json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return data
        }
        json["type"] = type
        return (try? JSONSerialization.data(withJSONObject: json)) ?? data
    }
}
