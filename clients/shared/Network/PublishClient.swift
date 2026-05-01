import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "PublishClient")

/// Focused client for page publishing operations routed through the gateway.
public protocol PublishClientProtocol {
    func publishPage(html: String, title: String?, appId: String?) async throws -> PublishPageResponseMessage?
    func unpublishPage(deploymentId: String) async -> Bool
}

/// Gateway-backed implementation of ``PublishClientProtocol``.
public struct PublishClient: PublishClientProtocol {
    nonisolated public init() {}

    public func publishPage(html: String, title: String? = nil, appId: String? = nil) async throws -> PublishPageResponseMessage? {
        var body: [String: Any] = ["type": "publish_page", "html": html]
        if let title { body["title"] = title }
        if let appId { body["appId"] = appId }

        let response = try await GatewayHTTPClient.post(
            path: "publish", json: body, timeout: 30
        )
        guard response.isSuccess else {
            log.error("publishPage failed (HTTP \(response.statusCode))")
            return nil
        }
        let patched = injectType("publish_page_response", into: response.data)
        return try JSONDecoder().decode(PublishPageResponseMessage.self, from: patched)
    }

    public func unpublishPage(deploymentId: String) async -> Bool {
        do {
            let body: [String: Any] = ["type": "unpublish_page", "deploymentId": deploymentId]
            let response = try await GatewayHTTPClient.post(
                path: "unpublish", json: body, timeout: 10
            )
            guard response.isSuccess else {
                log.error("unpublishPage failed (HTTP \(response.statusCode))")
                return false
            }
            return true
        } catch {
            log.error("unpublishPage error: \(error.localizedDescription)")
            return false
        }
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
