import SwiftUI
import VellumAssistantShared

/// Debug settings tab — hosts developer-leaning tools that still belong in
/// the primary settings list, like backups. Lives separately from the
/// Developer tab so non-developers can discover it.
@MainActor
struct SettingsDebugTab: View {
    @ObservedObject var store: SettingsStore

    @State private var lockfileAssistants: [LockfileAssistant] = []
    @State private var selectedAssistantId: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            if let assistant = lockfileAssistants.first(where: { $0.assistantId == selectedAssistantId }) {
                AssistantBackupsSection(assistant: assistant, store: store)
            }
        }
        .onAppear {
            selectedAssistantId = LockfileAssistant.loadActiveAssistantId() ?? ""
            Task {
                let assistants = await Task.detached { LockfileAssistant.loadAll() }.value
                lockfileAssistants = assistants
            }
        }
    }
}
