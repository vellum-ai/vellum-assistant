import SwiftUI

struct VSplitView<Main: View, Panel: View>: View {
    let main: Main
    let panel: Panel?
    var panelWidth: CGFloat = 320
    var showPanel: Bool = false

    var body: some View {
        HStack(spacing: 0) {
            main
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            if showPanel, let panel = panel {
                Divider()
                    .background(VColor.surfaceBorder)

                panel
                    .frame(width: panelWidth)
                    .background(VColor.backgroundSubtle)
                    .transition(.move(edge: .trailing))
            }
        }
        .animation(VAnimation.standard, value: showPanel)
    }

    init(
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

extension VSplitView where Panel == EmptyView {
    init(
        @ViewBuilder main: () -> Main
    ) {
        self.main = main()
        self.panel = nil
        self.panelWidth = 320
        self.showPanel = false
    }
}
