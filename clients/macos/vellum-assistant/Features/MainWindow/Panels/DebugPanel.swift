import SwiftUI

struct DebugPanel: View {
    var onClose: () -> Void
    var body: some View {
        VSidePanel(title: "Debug", onClose: onClose) {
            VEmptyState(title: "No debug info", subtitle: "Debug information will appear here", icon: "ant")
        }
    }
}

#Preview {
    DebugPanel(onClose: {})
}
