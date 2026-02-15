import SwiftUI

public struct VSplitView<Main: View, Panel: View>: View {
    public let main: Main
    public let panel: Panel?
    public var panelWidth: CGFloat = 320
    public var showPanel: Bool = false

    public var body: some View {
        HStack(spacing: 0) {
            // Main content - shrinks when panel appears
            main
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            // Panel slides in from right, pushing content
            if showPanel, let panel = panel {
                panel
                    .frame(width: panelWidth)
                    .background(VColor.backgroundSubtle)
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                    .padding(.vertical, VSpacing.sm)
                    .padding(.horizontal, VSpacing.sm)
                    .transition(.move(edge: .trailing))
            }
        }
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: showPanel)
    }

    public init(
        panelWidth: CGFloat = 320,
        showPanel: Bool = false,
        @ViewBuilder main: () -> Main,
        @ViewBuilder panel: () -> Panel
    ) {
        self.main = main()
        self.panel = panel()
        self.panelWidth = panelWidth
        self.showPanel = showPanel
    }
}

public extension VSplitView where Panel == EmptyView {
    init(
        @ViewBuilder main: () -> Main
    ) {
        self.main = main()
        self.panel = nil
        self.panelWidth = 320
        self.showPanel = false
    }
}

#Preview("VSplitView") {
    ZStack {
        VColor.background.ignoresSafeArea()
        VSplitView(panelWidth: 200, showPanel: true) {
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
