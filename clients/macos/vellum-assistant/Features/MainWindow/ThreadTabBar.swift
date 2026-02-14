import SwiftUI

struct ThreadTabBar: View {
    let threads: [ThreadModel]
    let activeThreadId: UUID?
    let onSelect: (UUID) -> Void
    let onClose: (UUID) -> Void
    let onCreate: () -> Void
    @Binding var activePanel: SidePanelType?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                ForEach(Array(threads.enumerated()), id: \.element.id) { index, thread in
                    if index > 0 {
                        Rectangle()
                            .fill(Slate._600)
                            .frame(width: 1, height: 14)
                    }

                    ThreadTab(
                        label: thread.title,
                        icon: "flame",
                        isSelected: thread.id == activeThreadId,
                        isCloseable: threads.count > 1,
                        onSelect: { onSelect(thread.id) },
                        onClose: { onClose(thread.id) }
                    )
                }

                Rectangle()
                    .fill(Slate._600)
                    .frame(width: 1, height: 14)
                    .padding(VSpacing.xs)


                VTab(label: "Thread", icon: "plus", isCloseable: false, style: .rectangular, onSelect: { onCreate() })
                    .accessibilityLabel("New Thread")

                Spacer()

                // Panel toggle buttons
                HStack(spacing: VSpacing.sm) {
                    VIconButton(label: "Generated", icon: "wand.and.stars", isActive: activePanel == .generated) {
                        togglePanel(.generated)
                    }
                    VIconButton(label: "Skills", icon: "exclamationmark.triangle", isActive: activePanel == .agent) {
                        togglePanel(.agent)
                    }
                    VIconButton(label: "Settings", icon: "gearshape", isActive: activePanel == .settings) {
                        togglePanel(.settings)
                    }
                    VIconButton(label: "Directory", icon: "doc.text", isActive: activePanel == .directory, iconOnly: true) {
                        togglePanel(.directory)
                    }
                    VIconButton(label: "Debug", icon: "ant", isActive: activePanel == .debug, iconOnly: true) {
                        togglePanel(.debug)
                    }
                    VIconButton(label: "Doctor", icon: "stethoscope", isActive: activePanel == .doctor, iconOnly: true) {
                        togglePanel(.doctor)
                    }
                }
            }
            .padding(.leading, 78)
            .padding(.trailing, VSpacing.lg)
            .frame(height: 36)
            .background(VColor.background)
        }
        .ignoresSafeArea(edges: .top)
    }

    private func togglePanel(_ panel: SidePanelType) {
        if activePanel == panel {
            activePanel = nil
        } else {
            activePanel = panel
        }
    }
}

#Preview("ThreadTabBar") {
    @Previewable @State var panel: SidePanelType? = .settings
    let threads = [
        ThreadModel(title: "New Thread"),
    ]

    return ZStack {
        VColor.background.ignoresSafeArea()
        ThreadTabBar(
            threads: threads,
            activeThreadId: threads.first?.id,
            onSelect: { _ in },
            onClose: { _ in },
            onCreate: {},
            activePanel: $panel
        )
    }
    .frame(width: 600, height: 60)
}
