import VellumAssistantShared
import SwiftUI

struct AssistantInboxPanel: View {
    var onClose: () -> Void

    var body: some View {
        VSidePanel(title: "Inbox", onClose: onClose) {
            VEmptyState(
                title: "No messages",
                subtitle: "Messages from your assistant will appear here",
                icon: "tray.fill"
            )
        }
    }
}

#Preview {
    AssistantInboxPanel(onClose: {})
}
