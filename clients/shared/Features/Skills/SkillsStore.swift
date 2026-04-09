import Foundation

/// Cross-platform store for skills data operations.
///
/// Encapsulates all daemon communication for listing, searching,
/// installing, uninstalling, enabling, disabling, configuring, drafting, and
/// creating skills. Platform-specific UI state (panel presentation, tab
/// selection, etc.) remains in the platform view model that delegates here.
@MainActor
public final class SkillsStore: ObservableObject {

    // MARK: - Published State

    @Published public var skills: [SkillInfo] = []
    @Published public var loadedBodies: [String: String] = [:]
    @Published public var isLoading = false

    @Published public var searchResults: [SkillInfo] = []
    @Published public var isSearching = false

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

    /// Per-file loaded content keyed by the file's relative path within the skill.
    @Published public var loadedFileContents: [String: String] = [:]
    /// Paths with an in-flight content fetch.
    @Published public var loadingFilePaths: Set<String> = []
    /// Per-path error messages from failed content fetches.
    @Published public var fileContentErrors: [String: String] = [:]

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
    private var lastSearchQuery: String?
    private var draftTask: Task<Void, Never>?
    private var createTask: Task<Void, Never>?
    private var skillDetailTask: Task<Void, Never>?
    private var skillFilesTask: Task<Void, Never>?
    private var fileContentTasks: [String: Task<Void, Never>] = [:]
    private var draftGeneration: Int = 0
    private var createGeneration: Int = 0
    private var currentDetailSkillId: String?
    private var currentFilesSkillId: String?

    // MARK: - Init

    public init() {
        self.skillsClient = SkillsClient()
    }

    public init(skillsClient: SkillsClientProtocol) {
        self.skillsClient = skillsClient
    }

    // MARK: - Fetch Skills

    public func fetchSkills(force: Bool = false) {
        guard !isLoading else { return }
        if !force && !skills.isEmpty { return }
        isLoading = true

        Task {
            let response = await skillsClient.fetchSkillsList(includeCatalog: true)
            if let response {
                skills = response.skills
            }
            isLoading = false
        }
    }

    // MARK: - Fetch Skill Body

    public func fetchSkillBody(skillId: String) {
        guard loadedBodies[skillId] == nil else { return }
        Task {
            guard let result = await skillsClient.fetchSkillFiles(skillId: skillId) else { return }
            // Extract the body from the SKILL.md file entry
            if let skillFile = result.files.first(where: { $0.name == "SKILL.md" }),
               let content = skillFile.content {
                loadedBodies[skillId] = content
            }
        }
    }

    // MARK: - Search Skills

    public func searchSkills(query: String = "", force: Bool = false) {
        guard !isSearching else { return }
        if !force && !searchResults.isEmpty && lastSearchQuery == query { return }
        isSearching = true

        Task {
            let result = await skillsClient.searchSkills(query: query)
            if let result, result.success {
                searchResults = result.skills
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
        // Cancel any in-flight files task and start a new one. Intentionally do
        // not early-return when `currentFilesSkillId == skillId`: a re-fetch
        // for the same skill replaces stale (lazy/null) file content with
        // fresh content after an install transition, so the store must always
        // reissue the request rather than reuse the prior response.
        skillFilesTask?.cancel()
        if currentFilesSkillId != skillId {
            selectedSkillFiles = nil
            clearLoadedFileContents()
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

    // MARK: - Lazy File Content

    public func loadSkillFileContent(skillId: String, path: String) {
        // Cancel any in-flight task for the same path so a second click replaces the first.
        fileContentTasks[path]?.cancel()
        loadingFilePaths.insert(path)
        fileContentErrors[path] = nil

        let task = Task { [weak self] in
            guard let self else { return }
            let result = await self.skillsClient.fetchSkillFileContent(skillId: skillId, path: path)
            await MainActor.run {
                guard self.currentFilesSkillId == skillId else { return }
                self.loadingFilePaths.remove(path)
                if let result, let content = result.content {
                    self.loadedFileContents[path] = content
                } else if let result, result.content == nil, result.isBinary {
                    // Binary file — no preview available is expected, not an error.
                    self.loadedFileContents.removeValue(forKey: path)
                } else {
                    self.fileContentErrors[path] = "Failed to load file content"
                }
            }
        }
        fileContentTasks[path] = task
    }

    public func clearLoadedFileContents() {
        for task in fileContentTasks.values { task.cancel() }
        fileContentTasks.removeAll()
        loadedFileContents.removeAll()
        loadingFilePaths.removeAll()
        fileContentErrors.removeAll()
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
        clearLoadedFileContents()
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
