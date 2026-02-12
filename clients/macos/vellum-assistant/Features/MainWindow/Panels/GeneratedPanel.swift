import SwiftUI

struct GeneratedPanel: View {
    var onClose: () -> Void

    var body: some View {
        VSidePanel(title: "Generated", onClose: onClose) {
            VEmptyState(
                title: "No generated items",
                subtitle: "Items created by your assistant will appear here",
                icon: "wand.and.stars"
            )
        }
    }
}

#Preview {
    GeneratedPanel(onClose: {})
}
