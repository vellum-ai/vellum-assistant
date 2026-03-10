import Combine
import Foundation

/// Cross-platform store for skills data operations.
///
/// Encapsulates all daemon communication for listing, searching, inspecting,
/// installing, uninstalling, enabling, disabling, configuring, drafting, and
/// creating skills. Platform-specific UI state (panel presentation, tab
/// selection, etc.) remains in the platform view model that delegates here.
@MainActor
public final class SkillsStore: ObservableObject {

    // MARK: - Published State

    @Published public var skills: [SkillInfo] = []
    @Published public var loadedBodies: [String: String] = [:]
    @Published public var isLoading = false

    @Published public var searchResults: [ClawhubSkillItem] = []
    @Published public var isSearching = false

    @Published public var inspectedSkill: ClawhubInspectData?
    @Published public var isInspecting = false
    @Published public var inspectError: String?

    @Published public var installResult: InstallResult?

    @Published public var uninstallResult: UninstallResult?
    @Published public var isUninstalling = false

    @Published public var draftResult: SkillDraftResult?
    @Published public var isDrafting = false
    @Published public var draftError: String?

    @Published public var isCreating = false
    @Published public var createError: String?

    // MARK: - Result Types

    public struct InstallResult: Sendable {
        public let slug: String
        public let success: Bool
        public let error: String?

        public init(slug: String, success: Bool, error: String?) {
            self.slug = slug
            self.success = success
            self.error = error
        }
    }

    public struct UninstallResult: Sendable {
        public let id: String
        public let success: Bool
        public let error: String?

        public init(id: String, success: Bool, error: String?) {
            self.id = id
            self.success = success
            self.error = error
        }
    }

    public struct SkillDraftResult: Sendable {
        public let skillId: String
        public let name: String
        public let description: String
        public let emoji: String?
        public let bodyMarkdown: String
        public let warnings: [String]

        public init(skillId: String, name: String, description: String, emoji: String?, bodyMarkdown: String, warnings: [String]) {
            self.skillId = skillId
            self.name = name
            self.description = description
            self.emoji = emoji
            self.bodyMarkdown = bodyMarkdown
            self.warnings = warnings
        }
    }

    // MARK: - Private State

    private let daemonClient: DaemonClient
    private var inspectCache: [String: ClawhubInspectData] = [:]
    private var currentInspectSlug: String?
    private var lastSearchQuery: String?
    private var draftTask: Task<Void, Never>?
    private var createTask: Task<Void, Never>?
    private var draftGeneration: Int = 0
    private var createGeneration: Int = 0

    // MARK: - Init

    public init(daemonClient: DaemonClient) {
        self.daemonClient = daemonClient
    }

    // MARK: - Fetch Skills

    public func fetchSkills(force: Bool = false) {
        guard !isLoading else { return }
        if !force && !skills.isEmpty { return }
        isLoading = true

        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.send(SkillsListRequestMessage())
            } catch {
                isLoading = false
                return
            }

            let result = await stream.firstMatch { message -> [SkillInfo]? in
                if case .skillsListResponse(let response) = message {
                    return response.skills
                }
                return nil
            }
            skills = result ?? skills
            isLoading = false
        }
    }

    // MARK: - Fetch Skill Body

    public func fetchSkillBody(skillId: String) {
        guard loadedBodies[skillId] == nil else { return }

        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.send(SkillDetailRequestMessage(skillId: skillId))
            } catch {
                return
            }

            let body = await stream.firstMatch { message -> String? in
                if case .skillDetailResponse(let response) = message,
                   response.skillId == skillId {
                    if let error = response.error {
                        return "Error: \(error)"
                    }
                    return response.body
                }
                return nil
            }
            if let body {
                loadedBodies[skillId] = body
            }
        }
    }

    // MARK: - Search Skills

    public func searchSkills(query: String = "", force: Bool = false) {
        guard !isSearching else { return }
        if !force && !searchResults.isEmpty && lastSearchQuery == query { return }
        isSearching = true

        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.searchSkills(query: query)
            } catch {
                isSearching = false
                return
            }

            let result = await stream.firstMatch { message -> [ClawhubSkillItem]? in
                if case .skillsOperationResponse(let response) = message,
                   response.operation == "search" {
                    if response.success, let data = response.data {
                        return data.skills
                    }
                    return [] // signal completion with empty on failure
                }
                return nil
            }
            if let result {
                searchResults = result
                lastSearchQuery = query
            }
            isSearching = false
        }
    }

    // MARK: - Install Skill

    public func installSkill(slug: String) {
        installResult = nil

        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.installSkill(slug: slug)
            } catch {
                installResult = InstallResult(slug: slug, success: false, error: "Failed to connect")
                return
            }

            let result = await stream.firstMatch { message -> InstallResult? in
                if case .skillsOperationResponse(let response) = message,
                   response.operation == "install" {
                    if response.success {
                        return InstallResult(slug: slug, success: true, error: nil)
                    } else {
                        return InstallResult(slug: slug, success: false, error: response.error)
                    }
                }
                return nil
            }
            if let result {
                installResult = result
                if result.success {
                    inspectCache.removeValue(forKey: slug)
                    fetchSkills(force: true)
                }
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                    if self.installResult?.slug == slug {
                        self.installResult = nil
                    }
                }
            }
        }
    }

    // MARK: - Inspect Skill

    public func inspectSkill(slug: String) {
        currentInspectSlug = slug
        inspectError = nil

        if let cached = inspectCache[slug] {
            inspectedSkill = cached
            isInspecting = false
            return
        }

        isInspecting = true
        inspectedSkill = nil

        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.inspectSkill(slug: slug)
            } catch {
                guard currentInspectSlug == slug else { return }
                isInspecting = false
                inspectError = "Failed to connect"
                return
            }

            let response = await stream.firstMatch { message -> SkillsInspectResponseMessage? in
                if case .skillsInspectResponse(let response) = message,
                   response.slug == slug {
                    return response
                }
                return nil
            }
            guard currentInspectSlug == slug else { return }
            if let data = response?.data {
                inspectedSkill = data
                inspectCache[slug] = data
            } else {
                inspectError = response?.error ?? "Inspection timed out"
            }
            isInspecting = false
        }
    }

    // MARK: - Uninstall Skill

    public func uninstallSkill(id: String) {
        guard !isUninstalling else { return }
        isUninstalling = true
        uninstallResult = nil

        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.uninstallSkill(id)
            } catch {
                isUninstalling = false
                uninstallResult = UninstallResult(id: id, success: false, error: "Failed to connect")
                return
            }

            let result = await stream.firstMatch { message -> UninstallResult? in
                if case .skillsOperationResponse(let response) = message,
                   response.operation == "uninstall" {
                    if response.success {
                        return UninstallResult(id: id, success: true, error: nil)
                    } else {
                        return UninstallResult(id: id, success: false, error: response.error)
                    }
                }
                return nil
            }
            if let result {
                uninstallResult = result
                if result.success {
                    inspectCache.removeAll()
                    fetchSkills(force: true)
                }
                Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                    if self.uninstallResult?.id == id {
                        self.uninstallResult = nil
                    }
                }
            }
            isUninstalling = false
        }
    }

    // MARK: - Enable / Disable

    public func enableSkill(name: String) throws {
        try daemonClient.enableSkill(name)
    }

    public func disableSkill(name: String) throws {
        try daemonClient.disableSkill(name)
    }

    // MARK: - Configure Skill

    public func configureSkill(name: String, env: [String: String]? = nil, apiKey: String? = nil, config: [String: AnyCodable]? = nil) throws {
        try daemonClient.configureSkill(name: name, env: env, apiKey: apiKey, config: config)
    }

    // MARK: - Clear Inspection

    public func clearInspection() {
        currentInspectSlug = nil
        inspectedSkill = nil
        isInspecting = false
        inspectError = nil
    }

    // MARK: - Skill Drafting

    public func draftSkill(sourceText: String) {
        guard !isDrafting else { return }
        isDrafting = true
        draftError = nil
        draftResult = nil
        draftGeneration += 1
        let generation = draftGeneration

        draftTask = Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.draftSkill(sourceText: sourceText)
            } catch {
                if generation == self.draftGeneration {
                    isDrafting = false
                    draftError = "Failed to send draft request"
                }
                return
            }

            // Extract the raw response; handle success/failure outside.
            let response = await stream.firstMatch { message -> SkillsDraftResponseMessage? in
                if case .skillsDraftResponse(let response) = message {
                    return response
                }
                return nil
            }
            guard generation == self.draftGeneration else { return }
            if let response {
                if response.success, let draft = response.draft {
                    draftResult = SkillDraftResult(
                        skillId: draft.skillId,
                        name: draft.name,
                        description: draft.description,
                        emoji: draft.emoji,
                        bodyMarkdown: draft.bodyMarkdown,
                        warnings: response.warnings ?? []
                    )
                } else {
                    draftError = response.error ?? "Draft generation failed"
                }
            }
            isDrafting = false
        }
    }

    // MARK: - Skill Creation

    public func createSkillFromDraft(skillId: String, name: String, description: String, emoji: String?, bodyMarkdown: String) {
        guard !isCreating else { return }
        isCreating = true
        createError = nil
        createGeneration += 1
        let generation = createGeneration

        createTask = Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.createSkill(
                    skillId: skillId,
                    name: name,
                    description: description,
                    emoji: emoji,
                    bodyMarkdown: bodyMarkdown
                )
            } catch {
                if generation == self.createGeneration {
                    isCreating = false
                    createError = "Failed to send create request"
                }
                return
            }

            let response = await stream.firstMatch { message -> SkillsOperationResponseMessage? in
                if case .skillsOperationResponse(let response) = message,
                   response.operation == "create" {
                    return response
                }
                return nil
            }
            guard generation == self.createGeneration else { return }
            if response?.success == true {
                fetchSkills(force: true)
            } else if let response {
                createError = response.error ?? "Failed to create skill"
            }
            isCreating = false
        }
    }

    // MARK: - Reset Draft State

    public func resetDraftState() {
        draftTask?.cancel()
        createTask?.cancel()
        draftTask = nil
        createTask = nil
        draftResult = nil
        isDrafting = false
        draftError = nil
        isCreating = false
        createError = nil
        draftGeneration += 1
        createGeneration += 1
    }
}
