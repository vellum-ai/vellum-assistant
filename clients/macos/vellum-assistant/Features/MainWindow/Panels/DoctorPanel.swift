import SwiftUI

struct DoctorPanel: View {
    var onClose: () -> Void
    var body: some View {
        VSidePanel(title: "Doctor", onClose: onClose) {
            VEmptyState(title: "No conversations", subtitle: "Support chat will appear here", icon: "stethoscope")
        }
    }
}

#Preview {
    DoctorPanel(onClose: {})
}
