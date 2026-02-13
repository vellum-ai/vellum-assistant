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
                    

                Spacer()
            }
            .padding(.leading, 78)
            .padding(.trailing, VSpacing.lg)
            .frame(height: 36)
            .background(VColor.background)
        }
        .ignoresSafeArea(edges: .top)
    }
}

#Preview("ThreadTabBar") {
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
            onCreate: {}
        )
    }
    .frame(width: 600, height: 60)
}
