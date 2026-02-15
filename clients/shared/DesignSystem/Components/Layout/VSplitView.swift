import SwiftUI

public struct VSplitView<Main: View, Panel: View>: View {
    public let main: Main
    public let panel: Panel?
    @Binding public var panelWidth: Double
    public var showPanel: Bool = false

    public var body: some View {
        HStack(spacing: 0) {
            // Main content - styled as panel
            main
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(VColor.backgroundSubtle)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                .padding([.bottom, .leading], VSpacing.sm)
                .padding(.trailing, showPanel && panel != nil ? 0 : VSpacing.sm)

            // Panel slides in from right, pushing content
            if showPanel, let panel = panel {
                // Drag divider (transparent but draggable)
                dragDivider

                panel
                    .frame(width: panelWidth)
                    .background(VColor.backgroundSubtle)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                    .padding([.bottom, .trailing], VSpacing.sm)
                    .transition(.move(edge: .trailing))
            }
        }
        .animation(VAnimation.standard, value: showPanel)
    }

    private var dragDivider: some View {
        Rectangle()
            .fill(Color.clear)
            .frame(width: VSpacing.sm)
            .contentShape(Rectangle())
            .onHover { hovering in
                if hovering {
                    NSCursor.resizeLeftRight.set()
                } else {
                    NSCursor.arrow.set()
                }
            }
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        // Dragging left (negative) increases width, dragging right (positive) decreases width
                        let newWidth = panelWidth - value.translation.width
                        panelWidth = min(max(newWidth, 300), 800)
                    }
            )
    }

    public init(
        panelWidth: Binding<Double>,
        showPanel: Bool = false,
        @ViewBuilder main: () -> Main,
        @ViewBuilder panel: () -> Panel
    ) {
        self.main = main()
        self.panel = panel()
        self._panelWidth = panelWidth
        self.showPanel = showPanel
    }
}

public extension VSplitView where Panel == EmptyView {
    init(
        @ViewBuilder main: () -> Main
    ) {
        self.main = main()
        self.panel = nil
        self._panelWidth = .constant(320)
        self.showPanel = false
    }
}

#Preview("VSplitView") {
    struct PreviewWrapper: View {
        @State private var panelWidth: Double = 200

        var body: some View {
            ZStack {
                VColor.background.ignoresSafeArea()
                VSplitView(panelWidth: $panelWidth, showPanel: true) {
                    VStack {
                        Text("Main Content")
                            .font(VFont.title)
                            .foregroundColor(VColor.textPrimary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(VColor.surface)
                } panel: {
                    VSidePanel(title: "Panel") {
                        Text("Side panel")
                            .font(VFont.body)
                            .foregroundColor(VColor.textSecondary)
                    }
                }
            }
            .frame(width: 600, height: 300)
        }
    }

    return PreviewWrapper()
}
