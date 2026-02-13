import SwiftUI

@MainActor
final class SkillsManager: ObservableObject {
    @Published var skills: [SkillInfo] = []
    @Published var loadedBodies: [String: String] = [:]
    @Published var isLoading = false

    private let daemonClient: DaemonClient

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

    func installSkill(slug: String) {
        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.installSkill(slug: slug)
            } catch {
                return
            }

            for await message in stream {
                if case .skillsOperationResponse(let response) = message,
                   response.operation == "install" {
                    if response.success {
                        // Refresh the skills list after successful install
                        fetchSkills()
                    }
                    return
                }
            }
        }
    }
}
