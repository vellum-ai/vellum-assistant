import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HTTPTransport")

// MARK: - Skills Domain Dispatcher

/// Registers a domain dispatcher that translates skill-related message
/// types into HTTP API calls. Handles:
///   skills_list, skills_enable, skills_disable, skills_configure,
///   skills_install, skills_uninstall, skills_update, skills_check_updates,
///   skills_search, skills_inspect, skills_draft, skills_create
extension HTTPTransport {

    func registerSkillRoutes() {
        registerDomainDispatcher { [weak self] message in
            guard let self else { return false }

            if message is SkillsListRequestMessage {
                Task { await self.fetchSkillsList() }
                return true
            } else if let msg = message as? SkillsEnableMessage {
                Task { await self.enableSkill(name: msg.name) }
                return true
            } else if let msg = message as? SkillsDisableMessage {
                Task { await self.disableSkill(name: msg.name) }
                return true
            } else if let msg = message as? SkillsConfigureMessage {
                Task { await self.configureSkill(name: msg.name, env: msg.env, apiKey: msg.apiKey, config: msg.config) }
                return true
            } else if let msg = message as? SkillsInstallMessage {
                Task { await self.installSkill(slug: msg.slug, version: msg.version) }
                return true
            } else if let msg = message as? SkillsUninstallMessage {
                Task { await self.uninstallSkill(name: msg.name) }
                return true
            } else if let msg = message as? SkillsUpdateMessage {
                Task { await self.updateSkill(name: msg.name) }
                return true
            } else if message is SkillsCheckUpdatesMessage {
                Task { await self.checkSkillUpdates() }
                return true
            } else if let msg = message as? SkillsSearchMessage {
                Task { await self.searchSkills(query: msg.query) }
                return true
            } else if let msg = message as? SkillsInspectMessage {
                Task { await self.inspectSkill(slug: msg.slug) }
                return true
            } else if let msg = message as? SkillsDraftRequestMessage {
                Task { await self.draftSkill(sourceText: msg.sourceText) }
                return true
            } else if let msg = message as? SkillsCreateMessage {
                Task {
                    await self.createSkill(
                        skillId: msg.skillId,
                        name: msg.name,
                        description: msg.description,
                        emoji: msg.emoji,
                        bodyMarkdown: msg.bodyMarkdown,
                        overwrite: msg.overwrite
                    )
                }
                return true
            }

            return false
        }
    }
}

// MARK: - Skill Detail HTTP Methods

extension HTTPTransport {

    /// Fetch full metadata for a single skill via `GET /v1/skills/:id`.
    func fetchSkillDetail(skillId: String, isRetry: Bool = false) async -> SkillDetailHTTPResponse? {
        guard let url = buildURL(for: .skillDetail(id: skillId)) else { return nil }

        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = refreshResult {
                        return await fetchSkillDetail(skillId: skillId, isRetry: true)
                    }
                    return nil
                }
                guard (200...299).contains(http.statusCode) else { return nil }
            }
            return try decoder.decode(SkillDetailHTTPResponse.self, from: data)
        } catch {
            log.error("fetchSkillDetail failed: \(error.localizedDescription)")
            return nil
        }
    }

    /// Fetch the directory contents of a skill via `GET /v1/skills/:id/files`.
    func fetchSkillFiles(skillId: String, isRetry: Bool = false) async -> SkillDetailFilesHTTPResponse? {
        guard let url = buildURL(for: .skillFiles(id: skillId)) else { return nil }

        var request = URLRequest(url: url)
        request.timeoutInterval = 15
        applyAuth(&request)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse {
                if http.statusCode == 401 && !isRetry {
                    let refreshResult = await handleAuthenticationFailureAsync(responseData: data)
                    if case .success = refreshResult {
                        return await fetchSkillFiles(skillId: skillId, isRetry: true)
                    }
                    return nil
                }
                guard (200...299).contains(http.statusCode) else { return nil }
            }
            return try decoder.decode(SkillDetailFilesHTTPResponse.self, from: data)
        } catch {
            log.error("fetchSkillFiles failed: \(error.localizedDescription)")
            return nil
        }
    }
}
