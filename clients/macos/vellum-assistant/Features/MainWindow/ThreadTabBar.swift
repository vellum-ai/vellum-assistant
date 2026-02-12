import SwiftUI

struct ThreadTabBar: View {
    let threads: [ThreadModel]
    let activeThreadId: UUID?
    let onSelect: (UUID) -> Void
    let onClose: (UUID) -> Void
    let onCreate: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                ForEach(threads) { thread in
                    VTab(
                        label: thread.title,
                        icon: "flame",
                        isSelected: thread.id == activeThreadId,
                        isCloseable: threads.count > 1,
                        style: .flat,
                        onSelect: { onSelect(thread.id) },
                        onClose: { onClose(thread.id) }
                    )
                }

                Button(action: onCreate) {
                    HStack(spacing: VSpacing.xs) {
                        Image(systemName: "plus")
                        Text("Thread")
                    }
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                }
                .buttonStyle(.plain)
                .vHover()
                .accessibilityLabel("New Thread")

                Spacer()
            }
            .padding(.horizontal, VSpacing.lg)
            .frame(height: 36)
            .background(VColor.background)
        }
    }
}

#Preview("ThreadTabBar") {
    ZStack {
        VColor.background.ignoresSafeArea()
        ThreadTabBar(
            threads: [
                ThreadModel(title: "New Thread"),
                ThreadModel(title: "Debug Session"),
                ThreadModel(title: "Research"),
            ],
            activeThreadId: nil,
            onSelect: { _ in },
            onClose: { _ in },
            onCreate: {}
        )
    }
    .frame(width: 600, height: 60)
}
