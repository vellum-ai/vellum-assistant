import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "MemoryRouterPlaygroundClient")

/// Errors surfaced by ``MemoryRouterPlaygroundClient``. Mirrors the
/// classification scheme used by ``CompactionPlaygroundClient``: a 404 from
/// the simulate endpoint typically means the daemon's `memory_v2.enabled`
/// gate is off, while other non-2xx responses surface as generic HTTP errors.
public enum MemoryRouterPlaygroundError: Error {
    /// Memory v2 isn't enabled on this assistant. The daemon returns 409
    /// `MEMORY_V2_DISABLED` from the simulate route's gate.
    case memoryV2Disabled
    /// The route isn't available at all (e.g. older daemon without the
    /// simulate endpoint shipped). Includes the path for diagnostics.
    case notAvailable
    /// Catch-all for non-2xx responses with a body the caller can show.
    case http(statusCode: Int, body: String)
}

/// Gateway-backed client for the daemon's `memory_v2_simulate_router` route.
///
/// Paths are gateway-relative — `GatewayHTTPClient` auto-prefixes the
/// `assistants/{assistantId}/` segment and routes to `/v1/*` on the daemon.
public struct MemoryRouterPlaygroundClient: Sendable {
    public init() {}

    public func simulate(
        input: MemoryRouterSimulateInput
    ) async throws -> MemoryRouterSimulateResponse {
        let path = "memory/v2/simulate-router/"
        let body = buildRequestBody(input: input)
        let response = try await GatewayHTTPClient.post(
            path: path,
            json: body,
            timeout: 120
        )
        try throwIfUnsuccessful(response, path: path)
        return try JSONDecoder().decode(
            MemoryRouterSimulateResponse.self,
            from: response.data
        )
    }

    /// Construct the JSON dict the daemon expects. Built by hand because the
    /// override fields have three states (inherit / value / explicit-null)
    /// and a plain Codable `Encodable` would conflate "absent" with "null".
    private func buildRequestBody(input: MemoryRouterSimulateInput) -> [String: Any] {
        var body: [String: Any] = ["query": input.query]
        var overrides: [String: Any] = [:]
        addOverride(input.tier1Size, key: "tier1_size", into: &overrides)
        addOverride(input.tier2Size, key: "tier2_size", into: &overrides)
        addOverride(input.batchSize, key: "batch_size", into: &overrides)
        if !overrides.isEmpty {
            body["configOverrides"] = overrides
        }
        return body
    }

    private func addOverride(
        _ override: MemoryRouterOverride,
        key: String,
        into dict: inout [String: Any]
    ) {
        switch override {
        case .inherit:
            return
        case .value(let n):
            dict[key] = n
        case .disable:
            dict[key] = NSNull()
        }
    }

    private func throwIfUnsuccessful(
        _ response: GatewayHTTPClient.Response,
        path: String
    ) throws {
        guard !response.isSuccess else { return }

        if response.statusCode == 409,
           let code = parseErrorCode(from: response.data),
           code == "MEMORY_V2_DISABLED" {
            log.error("memory router simulate 409 (memory v2 disabled) for path \(path, privacy: .public)")
            throw MemoryRouterPlaygroundError.memoryV2Disabled
        }
        if response.statusCode == 404 {
            log.error("memory router simulate 404 (route unavailable) for path \(path, privacy: .public)")
            throw MemoryRouterPlaygroundError.notAvailable
        }
        let bodyText = String(data: response.data, encoding: .utf8) ?? ""
        log.error("memory router simulate HTTP \(response.statusCode, privacy: .public) for path \(path, privacy: .public): \(bodyText, privacy: .public)")
        throw MemoryRouterPlaygroundError.http(
            statusCode: response.statusCode,
            body: bodyText
        )
    }

    /// Best-effort parse of `{ "error": { "code": "<string>" } }` from the
    /// response body. Returns `nil` on any structural mismatch so the caller
    /// can fall back to status-code-only classification.
    private func parseErrorCode(from data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let errorObj = json["error"] as? [String: Any],
              let code = errorObj["code"] as? String else {
            return nil
        }
        return code
    }
}
