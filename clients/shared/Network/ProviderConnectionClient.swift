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

/// Result of a `POST /v1/inference/provider-connections` request.
///
/// Differentiates the failure modes that warrant a specific user-facing
/// message — duplicate name (409) and invalid request (400) — from the
/// generic catch-all so the editor sheet can surface a precise reason
/// instead of a generic "please try again."
public enum ProviderConnectionCreateResult: Sendable {
    case created(ProviderConnection)
    /// 409 — a connection with the same name already exists.
    case duplicate
    /// 400 — invalid request. `message` carries the daemon's human-readable
    /// reason (e.g. `Invalid provider "x". Valid: ...`) when present in the
    /// `{ error: { message } }` envelope. May be nil if the body can't be
    /// parsed; callers should provide a sensible fallback.
    case invalid(message: String?)
    /// Anything else (network failure, 5xx, decode error).
    case error
}

/// Result of starting a ChatGPT subscription OAuth flow.
public struct ChatgptAuthStartResult: Sendable {
    public let authorizeUrl: String
    public let state: String
}

public protocol ProviderConnectionClientProtocol {
    func listProviderConnections(provider: String?) async -> [ProviderConnection]?
    func getProviderConnection(name: String) async -> ProviderConnection?
    /// `label` is optional; pass `nil` to omit from the request body.
    func createProviderConnection(name: String, provider: String, auth: ProviderConnectionAuth, label: String?, baseUrl: String?, models: [ConnectionModel]?) async -> ProviderConnectionCreateResult
    /// `label`: nil outer = omit; `.some(nil)` = send null (clear); `.some("v")` = set.
    func updateProviderConnection(name: String, auth: ProviderConnectionAuth, label: String??, baseUrl: String??, models: [ConnectionModel]??) async -> ProviderConnection?
    func deleteProviderConnection(name: String) async -> ProviderConnectionDeleteResult
    /// Start a ChatGPT subscription OAuth flow. Returns the authorize URL and state token.
    func startChatgptSubscriptionAuth() async -> ChatgptAuthStartResult?
    /// Exchange an OAuth authorization code for tokens, completing the ChatGPT subscription sign-in.
    func exchangeChatgptAuthCode(code: String, state: String) async -> Bool
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
        baseUrl: String? = nil,
        models: [ConnectionModel]? = nil
    ) async -> ProviderConnectionCreateResult {
        var body: [String: Any] = [
            "name": name,
            "provider": provider,
            "auth": Self.authDict(for: auth),
        ]
        if let label { body["label"] = label }
        if let baseUrl { body["base_url"] = baseUrl }
        if let models { body["models"] = models.map { model -> [String: Any] in var d: [String: Any] = ["id": model.id]; if let dn = model.displayName { d["displayName"] = dn }; return d } }
        do {
            let response = try await GatewayHTTPClient.post(
                path: "inference/provider-connections",
                json: body
            )
            switch response.statusCode {
            case 200..<300:
                do {
                    let conn = try JSONDecoder().decode(ProviderConnection.self, from: response.data)
                    return .created(conn)
                } catch {
                    log.error("createProviderConnection decode: \(error.localizedDescription, privacy: .public)")
                    return .error
                }
            case 409:
                return .duplicate
            case 400:
                return .invalid(message: Self.parseErrorMessage(from: response.data))
            default:
                log.warning("POST /inference/provider-connections failed: \(response.statusCode)")
                return .error
            }
        } catch {
            log.error("createProviderConnection: \(error.localizedDescription, privacy: .public)")
            return .error
        }
    }

    /// Extract `error.message` from the standard daemon error envelope
    /// `{ error: { code, message, details? } }`. Returns nil when the body
    /// can't be parsed or doesn't follow the envelope.
    private static func parseErrorMessage(from data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let error = json["error"] as? [String: Any],
              let message = error["message"] as? String else {
            return nil
        }
        return message
    }

    public func updateProviderConnection(
        name: String,
        auth: ProviderConnectionAuth,
        label: String?? = nil,
        baseUrl: String?? = nil,
        models: [ConnectionModel]?? = nil
    ) async -> ProviderConnection? {
        let encoded = Self.encodePath(name)
        var body: [String: Any] = ["auth": Self.authDict(for: auth)]
        if let outerLabel = label {
            body["label"] = outerLabel ?? NSNull()
        }
        if let outerBaseUrl = baseUrl {
            body["base_url"] = outerBaseUrl ?? NSNull()
        }
        if let outerModels = models {
            if let m = outerModels {
                body["models"] = m.map { model -> [String: Any] in var d: [String: Any] = ["id": model.id]; if let dn = model.displayName { d["displayName"] = dn }; return d }
            } else {
                body["models"] = NSNull()
            }
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

    public func startChatgptSubscriptionAuth() async -> ChatgptAuthStartResult? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "inference/chatgpt-subscription/auth",
                json: [:]
            )
            guard response.isSuccess else {
                log.warning("POST /inference/chatgpt-subscription/auth failed: \(response.statusCode)")
                return nil
            }
            guard let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
                  let authorizeUrl = json["authorize_url"] as? String,
                  let state = json["state"] as? String else {
                log.error("startChatgptSubscriptionAuth: unexpected response shape")
                return nil
            }
            return ChatgptAuthStartResult(authorizeUrl: authorizeUrl, state: state)
        } catch {
            log.error("startChatgptSubscriptionAuth: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    public func exchangeChatgptAuthCode(code: String, state: String) async -> Bool {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "inference/chatgpt-subscription/auth/exchange",
                json: ["code": code, "state": state]
            )
            guard response.isSuccess else {
                log.warning("POST /inference/chatgpt-subscription/auth/exchange failed: \(response.statusCode)")
                return false
            }
            return true
        } catch {
            log.error("exchangeChatgptAuthCode: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }
}

