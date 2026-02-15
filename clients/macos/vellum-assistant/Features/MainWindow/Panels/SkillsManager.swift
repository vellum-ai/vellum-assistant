import SwiftUI
import VellumAssistantShared

@MainActor
final class SkillsManager: ObservableObject {
    @Published var skills: [SkillInfo] = []
    @Published var loadedBodies: [String: String] = [:]
    @Published var isLoading = false
    @Published var searchResults: [ClawhubSkillItem] = []
    @Published var isSearching = false
    @Published var inspectedSkill: ClawhubInspectData?
    @Published var isInspecting = false
    @Published var inspectError: String?
    @Published var installResult: InstallResult?
    @Published var uninstallResult: UninstallResult?
    @Published var isUninstalling = false

    struct InstallResult {
        let slug: String
        let success: Bool
        let error: String?
    }

    struct UninstallResult {
        let name: String
        let success: Bool
        let error: String?
    }

    private let daemonClient: DaemonClient
    private var currentInspectSlug: String?

    init(daemonClient: DaemonClient) {
        self.daemonClient = daemonClient
    }

    func fetchSkills() {
        guard !isLoading else { return }
        isLoading = true

        Task {
            // Subscribe before sending so we don't miss fast daemon responses
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.send(SkillsListRequestMessage())
            } catch {
                isLoading = false
                return
            }

            for await message in stream {
                if case .skillsListResponse(let response) = message {
                    skills = response.skills
                    isLoading = false
                    return
                }
            }
            isLoading = false
        }
    }

    func fetchSkillBody(skillId: String) {
        guard loadedBodies[skillId] == nil else { return }

        Task {
            // Subscribe before sending so we don't miss fast daemon responses
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.send(SkillDetailRequestMessage(skillId: skillId))
            } catch {
                return
            }

            for await message in stream {
                if case .skillDetailResponse(let response) = message,
                   response.skillId == skillId {
                    if let error = response.error {
                        loadedBodies[skillId] = "Error: \(error)"
                    } else {
                        loadedBodies[skillId] = response.body
                    }
                    return
                }
            }
        }
    }

    func searchSkills(query: String = "") {
        guard !isSearching else { return }
        isSearching = true

        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.searchSkills(query: query)
            } catch {
                isSearching = false
                return
            }

            for await message in stream {
                if case .skillsOperationResponse(let response) = message,
                   response.operation == "search" {
                    if response.success, let data = response.data {
                        searchResults = data.skills
                    }
                    isSearching = false
                    return
                }
            }
            isSearching = false
        }
    }

    func installSkill(slug: String) {
        installResult = nil

        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.installSkill(slug: slug)
            } catch {
                installResult = InstallResult(slug: slug, success: false, error: "Failed to connect")
                return
            }

            for await message in stream {
                if case .skillsOperationResponse(let response) = message,
                   response.operation == "install" {
                    if response.success {
                        installResult = InstallResult(slug: slug, success: true, error: nil)
                        fetchSkills()
                    } else {
                        installResult = InstallResult(slug: slug, success: false, error: response.error)
                    }
                    // Auto-clear after 3 seconds
                    Task { @MainActor in
                        try? await Task.sleep(nanoseconds: 3_000_000_000)
                        if self.installResult?.slug == slug {
                            self.installResult = nil
                        }
                    }
                    return
                }
            }
        }
    }

    func inspectSkill(slug: String) {
        currentInspectSlug = slug
        isInspecting = true
        inspectedSkill = nil
        inspectError = nil

        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.inspectSkill(slug: slug)
            } catch {
                // Only update if still the current request
                guard currentInspectSlug == slug else { return }
                isInspecting = false
                inspectError = "Failed to connect"
                return
            }

            for await message in stream {
                if case .skillsInspectResponse(let response) = message,
                   response.slug == slug {
                    // Only update if still the current request
                    guard currentInspectSlug == slug else { return }
                    if let data = response.data {
                        inspectedSkill = data
                    } else {
                        inspectError = response.error ?? "Unknown error"
                    }
                    isInspecting = false
                    return
                }
            }
            if currentInspectSlug == slug {
                isInspecting = false
            }
        }
    }

    func uninstallSkill(name: String) {
        guard !isUninstalling else { return }
        isUninstalling = true
        uninstallResult = nil

        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.uninstallSkill(name)
            } catch {
                isUninstalling = false
                uninstallResult = UninstallResult(name: name, success: false, error: "Failed to connect")
                return
            }

            for await message in stream {
                if case .skillsOperationResponse(let response) = message,
                   response.operation == "uninstall" {
                    if response.success {
                        uninstallResult = UninstallResult(name: name, success: true, error: nil)
                        fetchSkills()
                    } else {
                        uninstallResult = UninstallResult(name: name, success: false, error: response.error)
                    }
                    isUninstalling = false
                    // Auto-clear after 3 seconds
                    Task { @MainActor in
                        try? await Task.sleep(nanoseconds: 3_000_000_000)
                        if self.uninstallResult?.name == name {
                            self.uninstallResult = nil
                        }
                    }
                    return
                }
            }
            isUninstalling = false
        }
    }

    func clearInspection() {
        currentInspectSlug = nil
        inspectedSkill = nil
        isInspecting = false
        inspectError = nil
    }
}
