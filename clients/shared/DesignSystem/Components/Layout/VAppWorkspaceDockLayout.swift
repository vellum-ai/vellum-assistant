import SwiftUI

public struct VAppWorkspaceDockLayout<Dock: View, Workspace: View>: View {
    // MARK: - Properties

    public let dock: Dock
    public let workspace: Workspace
    @Binding public var dockWidth: Double
    public var showDock: Bool = false
    public var dockBackground: Color?
    public var dockCornerRadius: CGFloat?
    @State private var dragStartWidth: Double?
    @State private var dragStartAvailableWidth: CGFloat?
    @State private var isDragging: Bool = false
    @State private var isDividerHovered: Bool = false
    @State private var availableWidth: CGFloat = 0
    private let dragCoordinateSpaceName = "AppWorkspaceDockDragCoordinateSpace"

    // MARK: - Layout Constants

    private static let minWorkspaceWidth: CGFloat = 300
    private static let dividerAndPadding: CGFloat = VSpacing.xs + 12

    // MARK: - Body

    public var body: some View {
        // Clamp dock width to the measured available space so the workspace
        // is never crushed below its minimum during layout transitions
        // (e.g. sidebar collapse animation where the binding computes for
        // the final sidebar width while the layout still uses the animated
        // intermediate width).
        let effectiveDockWidth: CGFloat = {
            guard showDock, availableWidth > 0 else { return CGFloat(dockWidth) }
            let maxAllowed = availableWidth - Self.minWorkspaceWidth - Self.dividerAndPadding
            return min(CGFloat(dockWidth), max(maxAllowed, 0))
        }()

        HStack(spacing: 0) {
            if showDock {
                dock
                    .frame(width: effectiveDockWidth)
                    .animation(nil, value: dockWidth)
                    .background(dockBackground ?? VColor.surfaceBase)
                    .clipShape(RoundedRectangle(cornerRadius: dockCornerRadius ?? VRadius.lg))
                    .padding([.bottom, .leading], VSpacing.xs)
                    .transition(.move(edge: .leading))

                dragDivider(availableWidth: availableWidth)
            }

            workspace
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(VColor.surfaceBase)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                .padding(.leading, showDock ? 0 : VSpacing.xs)
                .padding([.bottom, .trailing], VSpacing.xs)
        }
        .coordinateSpace(name: dragCoordinateSpaceName)
        .animation(isDragging ? nil : VAnimation.standard, value: showDock)
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.width
        } action: { newWidth in
            availableWidth = newWidth
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
        if dragStartWidth == nil || !isDragging {
            dragStartWidth = dockWidth
            dragStartAvailableWidth = availableWidth
            isDragging = true
        }

        guard let initialWidth = dragStartWidth,
              let initialAvailableWidth = dragStartAvailableWidth else {
            return
        }

        let deltaX = value.location.x - value.startLocation.x
        // Dragging right grows the dock (opposite of VSplitView's panel)
        let newWidth = initialWidth + Double(deltaX)

        let minDockWidth: CGFloat = 300
        let maxAllowed = initialAvailableWidth - Self.minWorkspaceWidth - Self.dividerAndPadding

        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            dockWidth = min(max(newWidth, minDockWidth), maxAllowed)
        }
    }

    private func resetDragState() {
        isDragging = false
        dragStartWidth = nil
        dragStartAvailableWidth = nil
    }

    // MARK: - Initialization

    public init(
        dockWidth: Binding<Double>,
        showDock: Bool = false,
        dockBackground: Color? = nil,
        dockCornerRadius: CGFloat? = nil,
        @ViewBuilder dock: () -> Dock,
        @ViewBuilder workspace: () -> Workspace
    ) {
        self.dock = dock()
        self.workspace = workspace()
        self._dockWidth = dockWidth
        self.showDock = showDock
        self.dockBackground = dockBackground
        self.dockCornerRadius = dockCornerRadius
    }
}
