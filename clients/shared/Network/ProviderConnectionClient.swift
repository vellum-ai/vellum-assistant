import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ProviderConnectionClient")

/// Result of a `DELETE /v1/inference/provider-connections/:name` request.
public enum ProviderConnectionDeleteResult: Sendable {
    case deleted
    case notFound
    case conflict(referencedBy: [String])
    case error
}

public protocol ProviderConnectionClientProtocol {
    func listProviderConnections(provider: String?) async -> [ProviderConnection]?
    func getProviderConnection(name: String) async -> ProviderConnection?
    /// `label` and `status` are optional extras; pass `nil` to omit from the request body.
    func createProviderConnection(name: String, provider: String, auth: ProviderConnectionAuth, label: String?, status: ConnectionStatus?) async -> ProviderConnection?
    /// `status`: nil = omit from body (no change). `label`: nil outer = omit; `.some(nil)` = send null (clear); `.some("v")` = set.
    func updateProviderConnection(name: String, auth: ProviderConnectionAuth, status: ConnectionStatus?, label: String??) async -> ProviderConnection?
    func deleteProviderConnection(name: String) async -> ProviderConnectionDeleteResult
}

public struct ProviderConnectionClient: ProviderConnectionClientProtocol {
    nonisolated public init() {}

    private static let pathComponentAllowed: CharacterSet = {
        var cs = CharacterSet.urlPathAllowed
        cs.remove(charactersIn: "/")
        return cs
    }()

    private static func encodePath(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: pathComponentAllowed) ?? value
    }

    private static func authDict(for auth: ProviderConnectionAuth) -> [String: Any] {
        var d: [String: Any] = ["type": auth.type]
        if let credential = auth.credential { d["credential"] = credential }
        return d
    }

    public func listProviderConnections(provider: String?) async -> [ProviderConnection]? {
        var params: [String: String]? = nil
        if let provider { params = ["provider": provider] }
        do {
            let response = try await GatewayHTTPClient.get(
                path: "inference/provider-connections",
                params: params
            )
            guard response.isSuccess else {
                log.warning("GET /inference/provider-connections failed: \(response.statusCode)")
                return nil
            }
            return try JSONDecoder().decode(ListProviderConnectionsResponse.self, from: response.data).connections
        } catch {
            log.error("listProviderConnections: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public func getProviderConnection(name: String) async -> ProviderConnection? {
        let encoded = Self.encodePath(name)
        do {
            let response = try await GatewayHTTPClient.get(
                path: "inference/provider-connections/\(encoded)"
            )
            guard response.isSuccess else {
                log.warning("GET /inference/provider-connections/\(name, privacy: .public) failed: \(response.statusCode)")
                return nil
            }
            return try JSONDecoder().decode(ProviderConnection.self, from: response.data)
        } catch {
            log.error("getProviderConnection(\(name, privacy: .public)): \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public func createProviderConnection(
        name: String,
        provider: String,
        auth: ProviderConnectionAuth,
        label: String? = nil,
        status: ConnectionStatus? = nil
    ) async -> ProviderConnection? {
        var body: [String: Any] = [
            "name": name,
            "provider": provider,
            "auth": Self.authDict(for: auth),
        ]
        if let label { body["label"] = label }
        if let status { body["status"] = status.rawValue }
        do {
            let response = try await GatewayHTTPClient.post(
                path: "inference/provider-connections",
                json: body
            )
            guard response.isSuccess else {
                log.warning("POST /inference/provider-connections failed: \(response.statusCode)")
                return nil
            }
            return try JSONDecoder().decode(ProviderConnection.self, from: response.data)
        } catch {
            log.error("createProviderConnection: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public func updateProviderConnection(
        name: String,
        auth: ProviderConnectionAuth,
        status: ConnectionStatus? = nil,
        label: String?? = nil
    ) async -> ProviderConnection? {
        let encoded = Self.encodePath(name)
        var body: [String: Any] = ["auth": Self.authDict(for: auth)]
        if let status { body["status"] = status.rawValue }
        if let outerLabel = label {
            body["label"] = outerLabel ?? NSNull()
        }
        do {
            let response = try await GatewayHTTPClient.patch(
                path: "inference/provider-connections/\(encoded)",
                json: body
            )
            guard response.isSuccess else {
                log.warning("PATCH /inference/provider-connections/\(name, privacy: .public) failed: \(response.statusCode)")
                return nil
            }
            return try JSONDecoder().decode(ProviderConnection.self, from: response.data)
        } catch {
            log.error("updateProviderConnection(\(name, privacy: .public)): \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public func deleteProviderConnection(name: String) async -> ProviderConnectionDeleteResult {
        let encoded = Self.encodePath(name)
        do {
            let response = try await GatewayHTTPClient.delete(
                path: "inference/provider-connections/\(encoded)"
            )
            switch response.statusCode {
            case 200..<300:
                return .deleted
            case 404:
                return .notFound
            case 409:
                return .conflict(referencedBy: parseConflictRefs(from: response.data))
            default:
                log.warning("DELETE /inference/provider-connections/\(name, privacy: .public) failed: \(response.statusCode)")
                return .error
            }
        } catch {
            log.error("deleteProviderConnection(\(name, privacy: .public)): \(error.localizedDescription, privacy: .public)")
            return .error
        }
    }

    private func parseConflictRefs(from data: Data) -> [String] {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return []
        }
        if let refs = json["referencedBy"] as? [String] { return refs }
        if let error = json["error"] as? [String: Any] {
            if let refs = (error["details"] as? [String: Any])?["referencedBy"] as? [String] { return refs }
            if let message = error["message"] as? String {
                return parseProfileNames(from: message)
            }
        }
        return []
    }

    private func parseProfileNames(from message: String) -> [String] {
        guard let colonRange = message.range(of: ": ", options: .backwards) else { return [] }
        var tail = String(message[colonRange.upperBound...])
        if tail.hasSuffix(".") { tail = String(tail.dropLast()) }
        let names = tail.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        return names.isEmpty ? [] : names
    }
}
