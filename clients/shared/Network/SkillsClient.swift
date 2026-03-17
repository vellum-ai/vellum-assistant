import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "SkillsClient")

/// Focused client for skills-related operations routed through the gateway.
///
/// Covers listing, enabling, disabling, configuring, installing, uninstalling,
/// updating, searching, inspecting, drafting, and creating skills.
@MainActor
public protocol SkillsClientProtocol {
    func fetchSkillsList() async -> SkillsListResponseMessage?
    func enableSkill(name: String) async -> SkillsOperationResponseMessage?
    func disableSkill(name: String) async -> SkillsOperationResponseMessage?
    func configureSkill(name: String, env: [String: String]?, apiKey: String?, config: [String: AnyCodable]?) async -> SkillsOperationResponseMessage?
    func installSkill(slug: String, version: String?) async -> SkillsOperationResponseMessage?
    func uninstallSkill(name: String) async -> SkillsOperationResponseMessage?
    func updateSkill(name: String) async -> SkillsOperationResponseMessage?
    func checkSkillUpdates() async -> SkillsOperationResponseMessage?
    func searchSkills(query: String) async -> SkillsOperationResponseMessage?
    func inspectSkill(slug: String) async -> SkillsInspectResponseMessage?
    func draftSkill(sourceText: String) async -> SkillsDraftResponseMessage?
    func createSkill(skillId: String, name: String, description: String, emoji: String?, bodyMarkdown: String, overwrite: Bool?) async -> SkillsOperationResponseMessage?
    func fetchSkillDetail(skillId: String) async -> SkillDetailHTTPResponse?
    func fetchSkillFiles(skillId: String) async -> SkillDetailFilesHTTPResponse?
}

/// Gateway-backed implementation of ``SkillsClientProtocol``.
@MainActor
public struct SkillsClient: SkillsClientProtocol {
    nonisolated public init() {}

    public func fetchSkillsList() async -> SkillsListResponseMessage? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/skills", timeout: 10
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

    public func enableSkill(name: String) async -> SkillsOperationResponseMessage? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/skills/\(name)/enable", timeout: 10
            )
            guard response.isSuccess else {
                log.error("enableSkill failed (HTTP \(response.statusCode))")
                return SkillsOperationResponseMessage(
                    operation: "enable", success: false,
                    error: extractErrorMessage(from: response.data), data: nil
                )
            }
            return SkillsOperationResponseMessage(
                operation: "enable", success: true, error: nil, data: nil
            )
        } catch {
            log.error("enableSkill error: \(error.localizedDescription)")
            return SkillsOperationResponseMessage(
                operation: "enable", success: false,
                error: error.localizedDescription, data: nil
            )
        }
    }

    public func disableSkill(name: String) async -> SkillsOperationResponseMessage? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/skills/\(name)/disable", timeout: 10
            )
            guard response.isSuccess else {
                log.error("disableSkill failed (HTTP \(response.statusCode))")
                return SkillsOperationResponseMessage(
                    operation: "disable", success: false,
                    error: extractErrorMessage(from: response.data), data: nil
                )
            }
            return SkillsOperationResponseMessage(
                operation: "disable", success: true, error: nil, data: nil
            )
        } catch {
            log.error("disableSkill error: \(error.localizedDescription)")
            return SkillsOperationResponseMessage(
                operation: "disable", success: false,
                error: error.localizedDescription, data: nil
            )
        }
    }

    public func configureSkill(name: String, env: [String: String]? = nil, apiKey: String? = nil, config: [String: AnyCodable]? = nil) async -> SkillsOperationResponseMessage? {
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
                path: "assistants/{assistantId}/skills/\(name)/config", json: body, timeout: 10
            )
            guard response.isSuccess else {
                log.error("configureSkill failed (HTTP \(response.statusCode))")
                return SkillsOperationResponseMessage(
                    operation: "configure", success: false,
                    error: extractErrorMessage(from: response.data), data: nil
                )
            }
            return SkillsOperationResponseMessage(
                operation: "configure", success: true, error: nil, data: nil
            )
        } catch {
            log.error("configureSkill error: \(error.localizedDescription)")
            return SkillsOperationResponseMessage(
                operation: "configure", success: false,
                error: error.localizedDescription, data: nil
            )
        }
    }

    public func installSkill(slug: String, version: String? = nil) async -> SkillsOperationResponseMessage? {
        do {
            var body: [String: Any] = ["slug": slug]
            if let version { body["version"] = version }

            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/skills/install", json: body, timeout: 10
            )
            guard response.isSuccess else {
                log.error("installSkill failed (HTTP \(response.statusCode))")
                return SkillsOperationResponseMessage(
                    operation: "install", success: false,
                    error: extractErrorMessage(from: response.data), data: nil
                )
            }
            return SkillsOperationResponseMessage(
                operation: "install", success: true, error: nil, data: nil
            )
        } catch {
            log.error("installSkill error: \(error.localizedDescription)")
            return SkillsOperationResponseMessage(
                operation: "install", success: false,
                error: error.localizedDescription, data: nil
            )
        }
    }

    public func uninstallSkill(name: String) async -> SkillsOperationResponseMessage? {
        do {
            let response = try await GatewayHTTPClient.delete(
                path: "assistants/{assistantId}/skills/\(name)", timeout: 10
            )
            guard response.isSuccess else {
                log.error("uninstallSkill failed (HTTP \(response.statusCode))")
                return SkillsOperationResponseMessage(
                    operation: "uninstall", success: false,
                    error: extractErrorMessage(from: response.data), data: nil
                )
            }
            return SkillsOperationResponseMessage(
                operation: "uninstall", success: true, error: nil, data: nil
            )
        } catch {
            log.error("uninstallSkill error: \(error.localizedDescription)")
            return SkillsOperationResponseMessage(
                operation: "uninstall", success: false,
                error: error.localizedDescription, data: nil
            )
        }
    }

    public func updateSkill(name: String) async -> SkillsOperationResponseMessage? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/skills/\(name)/update", timeout: 10
            )
            guard response.isSuccess else {
                log.error("updateSkill failed (HTTP \(response.statusCode))")
                return SkillsOperationResponseMessage(
                    operation: "update", success: false,
                    error: extractErrorMessage(from: response.data), data: nil
                )
            }
            return SkillsOperationResponseMessage(
                operation: "update", success: true, error: nil, data: nil
            )
        } catch {
            log.error("updateSkill error: \(error.localizedDescription)")
            return SkillsOperationResponseMessage(
                operation: "update", success: false,
                error: error.localizedDescription, data: nil
            )
        }
    }

    public func checkSkillUpdates() async -> SkillsOperationResponseMessage? {
        do {
            let response = try await GatewayHTTPClient.post(
                path: "assistants/{assistantId}/skills/check-updates", timeout: 10
            )
            guard response.isSuccess else {
                log.error("checkSkillUpdates failed (HTTP \(response.statusCode))")
                return SkillsOperationResponseMessage(
                    operation: "check_updates", success: false,
                    error: extractErrorMessage(from: response.data), data: nil
                )
            }
            return SkillsOperationResponseMessage(
                operation: "check_updates", success: true, error: nil, data: nil
            )
        } catch {
            log.error("checkSkillUpdates error: \(error.localizedDescription)")
            return SkillsOperationResponseMessage(
                operation: "check_updates", success: false,
                error: error.localizedDescription, data: nil
            )
        }
    }

    public func searchSkills(query: String) async -> SkillsOperationResponseMessage? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/skills/search",
                params: ["q": query],
                timeout: 10
            )
            guard response.isSuccess else {
                log.error("searchSkills failed (HTTP \(response.statusCode))")
                return SkillsOperationResponseMessage(
                    operation: "search", success: false,
                    error: extractErrorMessage(from: response.data), data: nil
                )
            }
            // REST returns { data: ... } with search results
            var searchData: ClawhubSearchData?
            if let json = try? JSONSerialization.jsonObject(with: response.data) as? [String: Any],
               let dataObj = json["data"],
               let dataBytes = try? JSONSerialization.data(withJSONObject: dataObj) {
                searchData = try? JSONDecoder().decode(ClawhubSearchData.self, from: dataBytes)
            }
            return SkillsOperationResponseMessage(
                operation: "search", success: true, error: nil, data: searchData
            )
        } catch {
            log.error("searchSkills error: \(error.localizedDescription)")
            return SkillsOperationResponseMessage(
                operation: "search", success: false,
                error: error.localizedDescription, data: nil
            )
        }
    }

    public func inspectSkill(slug: String) async -> SkillsInspectResponseMessage? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/skills/\(slug)/inspect", timeout: 10
            )
            guard response.isSuccess else {
                log.error("inspectSkill failed (HTTP \(response.statusCode))")
                return nil
            }
            // Inject type and slug if missing
            var json = (try? JSONSerialization.jsonObject(with: response.data) as? [String: Any]) ?? [:]
            json["type"] = "skills_inspect_response"
            if json["slug"] == nil { json["slug"] = slug }
            let enriched = (try? JSONSerialization.data(withJSONObject: json)) ?? response.data
            return try JSONDecoder().decode(SkillsInspectResponseMessage.self, from: enriched)
        } catch {
            log.error("inspectSkill error: \(error.localizedDescription)")
            return nil
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

    public func createSkill(skillId: String, name: String, description: String, emoji: String? = nil, bodyMarkdown: String, overwrite: Bool? = nil) async -> SkillsOperationResponseMessage? {
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
                return SkillsOperationResponseMessage(
                    operation: "create", success: false,
                    error: extractErrorMessage(from: response.data), data: nil
                )
            }
            return SkillsOperationResponseMessage(
                operation: "create", success: true, error: nil, data: nil
            )
        } catch {
            log.error("createSkill error: \(error.localizedDescription)")
            return SkillsOperationResponseMessage(
                operation: "create", success: false,
                error: error.localizedDescription, data: nil
            )
        }
    }

    public func fetchSkillDetail(skillId: String) async -> SkillDetailHTTPResponse? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/skills/\(skillId)", timeout: 10
            )
            guard response.isSuccess else {
                log.error("fetchSkillDetail failed (HTTP \(response.statusCode))")
                return nil
            }
            return try JSONDecoder().decode(SkillDetailHTTPResponse.self, from: response.data)
        } catch {
            log.error("fetchSkillDetail error: \(error.localizedDescription)")
            return nil
        }
    }

    public func fetchSkillFiles(skillId: String) async -> SkillDetailFilesHTTPResponse? {
        do {
            let response = try await GatewayHTTPClient.get(
                path: "assistants/{assistantId}/skills/\(skillId)/files", timeout: 15
            )
            guard response.isSuccess else {
                log.error("fetchSkillFiles failed (HTTP \(response.statusCode))")
                return nil
            }
            return try JSONDecoder().decode(SkillDetailFilesHTTPResponse.self, from: response.data)
        } catch {
            log.error("fetchSkillFiles error: \(error.localizedDescription)")
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
        return json["error"] as? String ?? json["message"] as? String
    }
}
