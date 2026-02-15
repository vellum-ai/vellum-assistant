import SwiftUI
#if os(macOS)
import AppKit
#endif

public struct VSplitView<Main: View, Panel: View>: View {
    public let main: Main
    public let panel: Panel?
    @Binding public var panelWidth: Double
    public var showPanel: Bool = false
    @State private var dragStartWidth: Double?
    @State private var dragStartAvailableWidth: CGFloat?
    @State private var isDragging: Bool = false

    public var body: some View {
        GeometryReader { geometry in
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
                    dragDivider(availableWidth: geometry.size.width)

                    panel
                        .frame(width: panelWidth)
                        .animation(nil, value: panelWidth)  // Disable animation on width changes
                        .background(VColor.backgroundSubtle)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                        .padding([.bottom, .trailing], VSpacing.sm)
                        .transition(.move(edge: .trailing))
                }
            }
            .animation(isDragging ? nil : VAnimation.standard, value: showPanel)
        }
    }

    private func dragDivider(availableWidth: CGFloat) -> some View {
        Rectangle()
            .fill(Color.clear)
            .frame(width: VSpacing.sm)
            .contentShape(Rectangle())
            #if os(macOS)
            .onHover { hovering in
                if hovering {
                    NSCursor.resizeLeftRight.set()
                } else {
                    NSCursor.arrow.set()
                }
            }
            #endif
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        // Capture initial state on first drag event
                        if dragStartWidth == nil {
                            dragStartWidth = panelWidth
                            dragStartAvailableWidth = availableWidth
                            isDragging = true
                        }

                        guard let initialWidth = dragStartWidth,
                              let initialAvailableWidth = dragStartAvailableWidth else {
                            return
                        }

                        // Dragging left (negative) increases width, dragging right (positive) decreases width
                        let newWidth = initialWidth - value.translation.width

                        // Compute max panel width: available width minus minimum main content (300pt), divider (8pt), and padding (16pt total)
                        let minMainContent: CGFloat = 300
                        let maxAllowed = initialAvailableWidth - minMainContent - VSpacing.sm - (VSpacing.sm * 2)

                        // Disable all animations during drag to prevent jitter
                        var transaction = Transaction()
                        transaction.disablesAnimations = true
                        withTransaction(transaction) {
                            panelWidth = min(max(newWidth, 300), maxAllowed)
                        }
                    }
                    .onEnded { _ in
                        // Reset drag state
                        isDragging = false
                        dragStartWidth = nil
                        dragStartAvailableWidth = nil
                    }
            )
            .onDisappear {
                // Reset drag state if view is removed mid-drag (e.g., panel closed)
                isDragging = false
                dragStartWidth = nil
                dragStartAvailableWidth = nil
            }
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
