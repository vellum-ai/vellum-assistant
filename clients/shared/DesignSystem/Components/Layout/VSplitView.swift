import SwiftUI

public struct VSplitView<Main: View, Panel: View>: View {
    // MARK: - Properties

    public let main: Main
    public let panel: Panel?
    @Binding public var panelWidth: Double
    public var showPanel: Bool = false
    public var mainBackground: Color?
    public var mainCornerRadius: CGFloat?
    @State private var dragStartWidth: Double?
    @State private var dragStartAvailableWidth: CGFloat?
    @State private var isDragging: Bool = false
    @State private var isDividerHovered: Bool = false
    private let dragCoordinateSpaceName = "VSplitViewDragCoordinateSpace"

    // MARK: - Body

    public var body: some View {
        GeometryReader { geometry in
            HStack(spacing: 0) {
                // Main content - styled as panel
                main
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(mainBackground ?? VColor.surfaceBase)
                    .clipShape(RoundedRectangle(cornerRadius: mainCornerRadius ?? VRadius.lg))
                    .padding([.bottom, .leading], VSpacing.xs)
                    .padding(.trailing, showPanel ? 0 : VSpacing.xs)

                // Panel slides in from right, pushing content
                if showPanel, let panel = panel {
                    // Drag divider (transparent but draggable)
                    dragDivider(availableWidth: geometry.size.width)

                    panel
                        .frame(width: panelWidth)
                        .animation(nil, value: panelWidth)  // Disable animation on width changes
                        .background(VColor.surfaceBase)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                        .padding([.bottom, .trailing], VSpacing.xs)
                        .transition(.move(edge: .trailing))
                }
            }
            .coordinateSpace(name: dragCoordinateSpaceName)
            .animation(isDragging ? nil : VAnimation.standard, value: showPanel)
        }
    }

    private func dragDivider(availableWidth: CGFloat) -> some View {
        ZStack {
            // Thin vertical line
            Rectangle()
                .fill(isDividerHovered || isDragging ? VColor.primaryBase : VColor.borderBase)
                .frame(width: 1)

            // Small pill — only visible on hover/drag
            if isDividerHovered || isDragging {
                Capsule()
                    .fill(VColor.primaryBase)
                    .frame(width: 4, height: 32)
                    .transition(.opacity)
            }
        }
        .frame(width: 8)
        .contentShape(Rectangle())
        .animation(VAnimation.fast, value: isDividerHovered)
        .animation(VAnimation.fast, value: isDragging)
        .onHover { hovering in
            isDividerHovered = hovering
        }
        .pointerCursor()
        .gesture(
            DragGesture(minimumDistance: 0, coordinateSpace: .named(dragCoordinateSpaceName))
                .onChanged { value in
                    self.handleDragChanged(value, availableWidth: availableWidth)
                }
                .onEnded { _ in
                    self.resetDragState()
                }
        )
        .onDisappear {
            self.resetDragState()
        }
    }

    // MARK: - Drag Helpers

    private func handleDragChanged(_ value: DragGesture.Value, availableWidth: CGFloat) {
        // Capture initial state on first drag event. Check both nil state AND isDragging
        // flag to handle race condition where async reset hasn't completed yet.
        if dragStartWidth == nil || !isDragging {
            dragStartWidth = panelWidth
            dragStartAvailableWidth = availableWidth
            isDragging = true
        }

        guard let initialWidth = dragStartWidth,
              let initialAvailableWidth = dragStartAvailableWidth else {
            return
        }

        // Measure drag in a stable parent coordinate space so the divider moving
        // during resize does not change the gesture's reference frame.
        let deltaX = value.location.x - value.startLocation.x
        let newWidth = initialWidth - Double(deltaX)

        // Calculate constraints
        let minPanelWidth: CGFloat = 300
        let minMainContentWidth: CGFloat = 300
        // main leading + divider (no trailing padding on main or panel when panel is shown)
        let dividerAndPadding = VSpacing.xs + 12
        let maxAllowed = initialAvailableWidth - minMainContentWidth - dividerAndPadding

        // Update width without animation to prevent jitter
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            panelWidth = min(max(newWidth, minPanelWidth), maxAllowed)
        }
    }

    private func resetDragState() {
        isDragging = false
        dragStartWidth = nil
        dragStartAvailableWidth = nil
    }

    // MARK: - Initialization

    public init(
        panelWidth: Binding<Double>,
        showPanel: Bool = false,
        mainBackground: Color? = nil,
        mainCornerRadius: CGFloat? = nil,
        @ViewBuilder main: () -> Main,
        @ViewBuilder panel: () -> Panel
    ) {
        self.main = main()
        self.panel = panel()
        self._panelWidth = panelWidth
        self.showPanel = showPanel
        self.mainBackground = mainBackground
        self.mainCornerRadius = mainCornerRadius
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
                VColor.surfaceOverlay.ignoresSafeArea()
                VSplitView(panelWidth: $panelWidth, showPanel: true) {
                    VStack {
                        Text("Main Content")
                            .font(VFont.title)
                            .foregroundColor(VColor.contentDefault)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(VColor.surfaceBase)
                } panel: {
                    VSidePanel(title: "Panel", pinnedContent: { EmptyView() }) {
                        Text("Side panel")
                            .font(VFont.body)
                            .foregroundColor(VColor.contentSecondary)
                    }
                }
            }
            .frame(width: 600, height: 300)
        }
    }

    return PreviewWrapper()
}
