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

    @Published public var selectedSkillDetail: SkillDetailHTTPResponse?
    @Published public var selectedSkillFiles: SkillDetailFilesHTTPResponse?
    @Published public var isLoadingSkillDetail = false
    @Published public var isLoadingSkillFiles = false
    @Published public var skillDetailError: String?
    @Published public var skillFilesError: String?

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

    private let skillsClient: SkillsClientProtocol
    /// Legacy daemon client retained only for `fetchSkillBody` which uses a
    /// message-transport endpoint without a REST equivalent.
    private weak var daemonClient: DaemonClient?
    private var inspectCache: [String: ClawhubInspectData] = [:]
    private var currentInspectSlug: String?
    private var lastSearchQuery: String?
    private var draftTask: Task<Void, Never>?
    private var createTask: Task<Void, Never>?
    private var skillDetailTask: Task<Void, Never>?
    private var skillFilesTask: Task<Void, Never>?
    private var draftGeneration: Int = 0
    private var createGeneration: Int = 0
    private var currentDetailSkillId: String?
    private var currentFilesSkillId: String?

    // MARK: - Init

    public init(daemonClient: DaemonClient) {
        self.skillsClient = SkillsClient()
        self.daemonClient = daemonClient
    }

    public init(skillsClient: SkillsClientProtocol, daemonClient: DaemonClient? = nil) {
        self.skillsClient = skillsClient
        self.daemonClient = daemonClient
    }

    // MARK: - Fetch Skills

    public func fetchSkills(force: Bool = false) {
        guard !isLoading else { return }
        if !force && !skills.isEmpty { return }
        isLoading = true

        Task {
            let response = await skillsClient.fetchSkillsList()
            if let response {
                skills = response.skills
            }
            isLoading = false
        }
    }

    // MARK: - Fetch Skill Body

    public func fetchSkillBody(skillId: String) {
        guard loadedBodies[skillId] == nil else { return }
        guard let daemonClient else { return }

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
            let response = await skillsClient.searchSkills(query: query)
            if let response, response.success, let data = response.data {
                searchResults = data.skills
            } else {
                searchResults = []
            }
            lastSearchQuery = query
            isSearching = false
        }
    }

    // MARK: - Install Skill

    public func installSkill(slug: String) {
        installResult = nil

        Task {
            let response = await skillsClient.installSkill(slug: slug, version: nil)
            let result: InstallResult
            if let response, response.success {
                result = InstallResult(slug: slug, success: true, error: nil)
            } else {
                result = InstallResult(slug: slug, success: false, error: response?.error ?? "Failed to connect")
            }
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
            let response = await skillsClient.inspectSkill(slug: slug)
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
            let response = await skillsClient.uninstallSkill(name: id)
            let result: UninstallResult
            if let response, response.success {
                result = UninstallResult(id: id, success: true, error: nil)
            } else {
                result = UninstallResult(id: id, success: false, error: response?.error ?? "Failed to connect")
            }
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
            isUninstalling = false
        }
    }

    // MARK: - Enable / Disable

    public func enableSkill(name: String) {
        Task {
            _ = await skillsClient.enableSkill(name: name)
            fetchSkills(force: true)
        }
    }

    public func disableSkill(name: String) {
        Task {
            _ = await skillsClient.disableSkill(name: name)
            fetchSkills(force: true)
        }
    }

    // MARK: - Configure Skill

    public func configureSkill(name: String, env: [String: String]? = nil, apiKey: String? = nil, config: [String: AnyCodable]? = nil) {
        Task { _ = await skillsClient.configureSkill(name: name, env: env, apiKey: apiKey, config: config) }
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
            let response = await skillsClient.draftSkill(sourceText: sourceText)
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
            } else {
                draftError = "Failed to send draft request"
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
            let response = await skillsClient.createSkill(
                skillId: skillId,
                name: name,
                description: description,
                emoji: emoji,
                bodyMarkdown: bodyMarkdown,
                overwrite: nil
            )
            guard generation == self.createGeneration else { return }
            if response?.success == true {
                fetchSkills(force: true)
            } else {
                createError = response?.error ?? "Failed to create skill"
            }
            isCreating = false
        }
    }

    // MARK: - Fetch Skill Detail

    public func fetchSkillDetail(skillId: String) {
        skillDetailTask?.cancel()
        if currentDetailSkillId != skillId {
            selectedSkillDetail = nil
        }
        currentDetailSkillId = skillId
        isLoadingSkillDetail = true
        skillDetailError = nil

        skillDetailTask = Task {
            let result = await skillsClient.fetchSkillDetail(skillId: skillId)
            guard !Task.isCancelled else { return }
            guard self.currentDetailSkillId == skillId else { return }
            if let result {
                selectedSkillDetail = result
            } else {
                skillDetailError = "Failed to load skill details"
            }
            isLoadingSkillDetail = false
        }
    }

    // MARK: - Fetch Skill Files

    public func fetchSkillFiles(skillId: String) {
        skillFilesTask?.cancel()
        if currentFilesSkillId != skillId {
            selectedSkillFiles = nil
        }
        currentFilesSkillId = skillId
        isLoadingSkillFiles = true
        skillFilesError = nil

        skillFilesTask = Task {
            let result = await skillsClient.fetchSkillFiles(skillId: skillId)
            guard !Task.isCancelled else { return }
            guard self.currentFilesSkillId == skillId else { return }
            if let result {
                selectedSkillFiles = result
            } else {
                skillFilesError = "Failed to load skill files"
            }
            isLoadingSkillFiles = false
        }
    }

    // MARK: - Clear Skill Detail

    public func clearSkillDetail() {
        skillDetailTask?.cancel()
        skillFilesTask?.cancel()
        skillDetailTask = nil
        skillFilesTask = nil
        currentDetailSkillId = nil
        currentFilesSkillId = nil
        selectedSkillDetail = nil
        selectedSkillFiles = nil
        isLoadingSkillDetail = false
        isLoadingSkillFiles = false
        skillDetailError = nil
        skillFilesError = nil
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
