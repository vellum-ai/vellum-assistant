import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "SkillsClient")

/// Focused client for skills-related operations routed through the gateway.
///
/// Covers listing, enabling, disabling, configuring, installing, uninstalling,
/// updating, searching, drafting, and creating skills.
public protocol SkillsClientProtocol {
    func fetchSkillsList(includeCatalog: Bool, origin: String?, kind: String?, query: String?, category: String?) async -> SkillsListResponseMessage?
    func enableSkill(name: String) async -> SkillOperationResult?
    func disableSkill(name: String) async -> SkillOperationResult?
    func configureSkill(name: String, env: [String: String]?, apiKey: String?, config: [String: AnyCodable]?) async -> SkillOperationResult?
    func installSkill(slug: String, version: String?) async -> SkillOperationResult?
    func uninstallSkill(name: String) async -> SkillOperationResult?
    func updateSkill(name: String) async -> SkillOperationResult?
    func checkSkillUpdates() async -> SkillOperationResult?
    func searchSkills(query: String) async -> SkillSearchResult?
    func draftSkill(sourceText: String) async -> SkillsDraftResponseMessage?
    func createSkill(skillId: String, name: String, description: String, emoji: String?, bodyMarkdown: String, overwrite: Bool?) async -> SkillOperationResult?
    func fetchSkillDetail(skillId: String) async -> SkillDetailHTTPResponse?
    func fetchSkillFiles(skillId: String) async -> SkillDetailFilesHTTPResponse?
    func fetchSkillFileContent(skillId: String, path: String) async -> SkillFileContentResponse?
}

/// Gateway-backed implementation of ``SkillsClientProtocol``.
public struct SkillsClient: SkillsClientProtocol {
    nonisolated public init() {}

    /// Percent-encode a value for use as a single URL path component.
    private static let pathComponentAllowed: CharacterSet = {
        var cs = CharacterSet.urlPathAllowed
        cs.remove(charactersIn: "/")
        return cs
    }()

    private static func encodePath(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: pathComponentAllowed) ?? value
    }

    public func fetchSkillsList(includeCatalog: Bool, origin: String? = nil, kind: String? = nil, query: String? = nil, category: String? = nil) async -> SkillsListResponseMessage? {
        do {
            var params: [String: String] = [:]
            if includeCatalog { params["include"] = "catalog" }
            if let origin { params["origin"] = origin }
            if let kind { params["kind"] = kind }
            if let query, !query.isEmpty { params["q"] = query }
            if let category { params["category"] = category }
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/skills", params: params.isEmpty ? nil : params, timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchSkillsList failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("skills_list_response", into: response.data)
            return try JSONDecoder().decode(SkillsListResponseMessage.self, from: patched)
        } catch {
            log.error("fetchSkillsList error: \(error.localizedDescription)")
            return nil
        }
    }

    public func enableSkill(name: String) async -> SkillOperationResult? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/skills/\(Self.encodePath(name))/enable", timeout: 10
            )
            guard response.isSuccess else {
                log.error("enableSkill failed (HTTP \(response.statusCode))")
                return SkillOperationResult(
                    success: false,
                    error: extractErrorMessage(from: response.data)
                )
            }
            return SkillOperationResult(success: true)
        } catch {
            log.error("enableSkill error: \(error.localizedDescription)")
            return SkillOperationResult(success: false, error: error.localizedDescription)
        }
    }

    public func disableSkill(name: String) async -> SkillOperationResult? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/skills/\(Self.encodePath(name))/disable", timeout: 10
            )
            guard response.isSuccess else {
                log.error("disableSkill failed (HTTP \(response.statusCode))")
                return SkillOperationResult(
                    success: false,
                    error: extractErrorMessage(from: response.data)
                )
            }
            return SkillOperationResult(success: true)
        } catch {
            log.error("disableSkill error: \(error.localizedDescription)")
            return SkillOperationResult(success: false, error: error.localizedDescription)
        }
    }

    public func configureSkill(name: String, env: [String: String]? = nil, apiKey: String? = nil, config: [String: AnyCodable]? = nil) async -> SkillOperationResult? {
        do {
            var body: [String: Any] = [:]
            if let env { body["env"] = env }
            if let apiKey { body["apiKey"] = apiKey }
            if let config {
                var rawConfig: [String: Any] = [:]
                for (key, value) in config {
                    rawConfig[key] = value.value
                }
                body["config"] = rawConfig
            }

            let response = try await GatewayHTTPClient.patch(
                path: "assistants/{assistantId}/skills/\(Self.encodePath(name))/config", json: body, timeout: 10
            )
            guard response.isSuccess else {
                log.error("configureSkill failed (HTTP \(response.statusCode))")
                return SkillOperationResult(
                    success: false,
                    error: extractErrorMessage(from: response.data)
                )
            }
            return SkillOperationResult(success: true)
        } catch {
            log.error("configureSkill error: \(error.localizedDescription)")
            return SkillOperationResult(success: false, error: error.localizedDescription)
        }
    }

    public func installSkill(slug: String, version: String? = nil) async -> SkillOperationResult? {
        do {
            var body: [String: Any] = ["slug": slug]
            if let version { body["version"] = version }

            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/skills/install", json: body, timeout: 120
            )
            guard response.isSuccess else {
                log.error("installSkill failed (HTTP \(response.statusCode))")
                return SkillOperationResult(
                    success: false,
                    error: extractErrorMessage(from: response.data)
                )
            }
            let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any]
            let skillId = json?["skillId"] as? String
            return SkillOperationResult(success: true, skillId: skillId)
        } catch {
            log.error("installSkill error: \(error.localizedDescription)")
            return SkillOperationResult(success: false, error: error.localizedDescription)
        }
    }

    public func uninstallSkill(name: String) async -> SkillOperationResult? {
        do {
            let response = try await GatewayHTTPClient.delete(
                path: "assistants/{assistantId}/skills/\(Self.encodePath(name))", timeout: 10
            )
            guard response.isSuccess else {
                log.error("uninstallSkill failed (HTTP \(response.statusCode))")
                return SkillOperationResult(
                    success: false,
                    error: extractErrorMessage(from: response.data)
                )
            }
            return SkillOperationResult(success: true)
        } catch {
            log.error("uninstallSkill error: \(error.localizedDescription)")
            return SkillOperationResult(success: false, error: error.localizedDescription)
        }
    }

    public func updateSkill(name: String) async -> SkillOperationResult? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/skills/\(Self.encodePath(name))/update", timeout: 10
            )
            guard response.isSuccess else {
                log.error("updateSkill failed (HTTP \(response.statusCode))")
                return SkillOperationResult(
                    success: false,
                    error: extractErrorMessage(from: response.data)
                )
            }
            return SkillOperationResult(success: true)
        } catch {
            log.error("updateSkill error: \(error.localizedDescription)")
            return SkillOperationResult(success: false, error: error.localizedDescription)
        }
    }

    public func checkSkillUpdates() async -> SkillOperationResult? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/skills/check-updates", timeout: 10
            )
            guard response.isSuccess else {
                log.error("checkSkillUpdates failed (HTTP \(response.statusCode))")
                return SkillOperationResult(
                    success: false,
                    error: extractErrorMessage(from: response.data)
                )
            }
            return SkillOperationResult(success: true)
        } catch {
            log.error("checkSkillUpdates error: \(error.localizedDescription)")
            return SkillOperationResult(success: false, error: error.localizedDescription)
        }
    }

    public func searchSkills(query: String) async -> SkillSearchResult? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/skills/search",
                params: ["q": query],
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("searchSkills failed (HTTP \(response.statusCode))")
                return SkillSearchResult(
                    success: false,
                    error: extractErrorMessage(from: response.data)
                )
            }
            // REST returns { skills: SkillsListResponseSkill[] } at top level.
            struct SearchResponse: Decodable { let skills: [SkillsListResponseSkill] }
            let decoded = try JSONDecoder().decode(SearchResponse.self, from: response.data)
            return SkillSearchResult(success: true, skills: decoded.skills)
        } catch {
            log.error("searchSkills error: \(error.localizedDescription)")
            return SkillSearchResult(success: false, error: error.localizedDescription)
        }
    }

    public func draftSkill(sourceText: String) async -> SkillsDraftResponseMessage? {
        do {
            let body: [String: Any] = ["sourceText": sourceText]
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/skills/draft", json: body, timeout: 30
            )
            guard response.isSuccess else {
                log.error("draftSkill failed (HTTP \(response.statusCode))")
                return nil
            }
            let patched = injectType("skills_draft_response", into: response.data)
            return try JSONDecoder().decode(SkillsDraftResponseMessage.self, from: patched)
        } catch {
            log.error("draftSkill error: \(error.localizedDescription)")
            return nil
        }
    }

    public func createSkill(skillId: String, name: String, description: String, emoji: String? = nil, bodyMarkdown: String, overwrite: Bool? = nil) async -> SkillOperationResult? {
        do {
            var body: [String: Any] = [
                "skillId": skillId,
                "name": name,
                "description": description,
                "bodyMarkdown": bodyMarkdown
            ]
            if let emoji { body["emoji"] = emoji }
            if let overwrite { body["overwrite"] = overwrite }

            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/skills", json: body, timeout: 10
            )
            guard response.isSuccess else {
                log.error("createSkill failed (HTTP \(response.statusCode))")
                return SkillOperationResult(
                    success: false,
                    error: extractErrorMessage(from: response.data)
                )
            }
            return SkillOperationResult(success: true)
        } catch {
            log.error("createSkill error: \(error.localizedDescription)")
            return SkillOperationResult(success: false, error: error.localizedDescription)
        }
    }

    public func fetchSkillDetail(skillId: String) async -> SkillDetailHTTPResponse? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/skills/\(Self.encodePath(skillId))", timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchSkillDetail failed (HTTP \(response.statusCode))")
                return nil
            }
            // REST returns { skill: SkillDetailHTTPResponse } — extract the inner object.
            guard let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
                  let skillObj = json["skill"],
                  let skillData = try? JSONSerialization.data(withJSONObject: skillObj) else {
                log.error("fetchSkillDetail: missing 'skill' key in response")
                return nil
            }
            return try JSONDecoder().decode(SkillDetailHTTPResponse.self, from: skillData)
        } catch is CancellationError {
            return nil
        } catch let urlError as URLError where urlError.code == .cancelled {
            return nil
        } catch {
            log.error("fetchSkillDetail error: \(error, privacy: .public)")
            return nil
        }
    }

    public func fetchSkillFiles(skillId: String) async -> SkillDetailFilesHTTPResponse? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/skills/\(Self.encodePath(skillId))/files", timeout: 15
            )
            guard response.isSuccess else {
                log.error("fetchSkillFiles failed (HTTP \(response.statusCode))")
                return nil
            }
            return try JSONDecoder().decode(SkillDetailFilesHTTPResponse.self, from: response.data)
        } catch is CancellationError {
            return nil
        } catch let urlError as URLError where urlError.code == .cancelled {
            return nil
        } catch {
            log.error("fetchSkillFiles error: \(error, privacy: .public)")
            return nil
        }
    }

    public func fetchSkillFileContent(skillId: String, path: String) async -> SkillFileContentResponse? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/skills/\(Self.encodePath(skillId))/files/content",
                params: ["path": path],
                timeout: 15
            )
            guard response.isSuccess else {
                log.error("fetchSkillFileContent failed (HTTP \(response.statusCode))")
                return nil
            }
            return try JSONDecoder().decode(SkillFileContentResponse.self, from: response.data)
        } catch is CancellationError {
            return nil
        } catch let urlError as URLError where urlError.code == .cancelled {
            return nil
        } catch {
            log.error("fetchSkillFileContent error: \(error, privacy: .public)")
            return nil
        }
    }

    // MARK: - Helpers

    private func injectType(_ type: String, into data: Data) -> Data {
        guard var json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return data
        }
        json["type"] = type
        return (try? JSONSerialization.data(withJSONObject: json)) ?? data
    }

    private func extractErrorMessage(from data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        if let errorObj = json["error"] as? [String: Any],
           let message = errorObj["message"] as? String {
            return message
        }
        if let error = json["error"] as? String { return error }
        if let message = json["message"] as? String { return message }
        return nil
    }
}
