import SwiftUI
import VellumAssistantShared

struct MessageInspectorMemoryTab: View {
    let memoryRecall: MemoryRecallData?

    var body: some View {
        VEmptyState(
            title: "Memory",
            subtitle: "Memory recall debugging information will appear here.",
            icon: VIcon.brain.rawValue
        )
    }
}
