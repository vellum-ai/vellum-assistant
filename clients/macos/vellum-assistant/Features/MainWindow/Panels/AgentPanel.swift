import SwiftUI

struct AgentPanel: View {
    var onClose: () -> Void

    var body: some View {
        VSidePanel(title: "Agent", onClose: onClose) {
            VStack(alignment: .leading, spacing: VSpacing.xl) {
                sectionHeader("Skills")
                VEmptyState(title: "No skills", subtitle: "Agent skills will appear here", icon: "bolt.fill")
                    .frame(height: 150)

                Divider()

                sectionHeader("Nodes")
                VEmptyState(title: "No nodes", subtitle: "Agent nodes will appear here", icon: "point.3.connected.trianglepath.dotted")
                    .frame(height: 150)
            }
        }
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title.uppercased())
            .font(VFont.captionMedium)
            .foregroundColor(VColor.textSecondary)
    }
}

#Preview {
    AgentPanel(onClose: {})
}
