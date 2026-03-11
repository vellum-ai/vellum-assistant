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
                        userInvocable: msg.userInvocable,
                        disableModelInvocation: msg.disableModelInvocation,
                        overwrite: msg.overwrite
                    )
                }
                return true
            }

            return false
        }
    }
}
