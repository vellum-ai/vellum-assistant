import SwiftUI

public struct VSplitButton<MenuContent: View>: View {
    /// Controls the chevron icon direction and, on macOS, the menu pop direction.
    public enum ChevronDirection {
        /// Chevron points down; menu appears below (default).
        case down
        /// Chevron points up; on macOS the menu appears above via VMenuPanel.
        case up
    }

    /// Controls the outer shape of the split button.
    public enum ButtonShape {
        /// Pill / capsule ends (fully rounded).
        case capsule
        /// Rounded rectangle matching `VRadius.md`.
        case roundedRectangle
    }

    public let label: String
    public var icon: String?
    public var style: VButton.Style
    public var size: VButton.Size
    public var isDisabled: Bool
    public var chevronDirection: ChevronDirection
    public var buttonShape: ButtonShape
    public var accessibilityID: String?
    public let action: () -> Void
    @ViewBuilder public let menuContent: () -> MenuContent

    @State private var isPrimaryHovered = false
    @State private var isDropdownHovered = false

    #if os(macOS)
    @State private var buttonFrame: CGRect = .zero
    @State private var activePanel: VMenuPanel?
    @State private var isMenuOpen = false
    #endif

    public init(
        label: String,
        icon: String? = nil,
        style: VButton.Style = .primary,
        size: VButton.Size = .regular,
        isDisabled: Bool = false,
        chevronDirection: ChevronDirection = .down,
        buttonShape: ButtonShape = .capsule,
        accessibilityID: String? = nil,
        action: @escaping () -> Void,
        @ViewBuilder menuContent: @escaping () -> MenuContent
    ) {
        self.label = label
        self.icon = icon
        self.style = style
        self.size = size
        self.isDisabled = isDisabled
        self.chevronDirection = chevronDirection
        self.buttonShape = buttonShape
        self.accessibilityID = accessibilityID
        self.action = action
        self.menuContent = menuContent
    }

    /// Matches VButton's ButtonLayoutModifier: regular=32, compact/pill=24.
    private var zoneHeight: CGFloat { size == .regular ? 32 : 24 }
    /// Dropdown zone is square (width == height).
    private var dropdownWidth: CGFloat { zoneHeight }

    private var chevronIcon: VIcon {
        chevronDirection == .up ? .chevronUp : .chevronDown
    }

    private var resolvedShape: AnyInsettableShape {
        switch buttonShape {
        case .capsule:
            return AnyInsettableShape(Capsule())
        case .roundedRectangle:
            return AnyInsettableShape(RoundedRectangle(cornerRadius: VRadius.md))
        }
    }

    public var body: some View {
        let shape = resolvedShape

        HStack(spacing: 0) {
            // Primary action zone
            Button(action: action) {
                HStack(spacing: VSpacing.sm) {
                    if let icon {
                        VIconView(.resolve(icon), size: VSize.iconDefault)
                    }
                    Text(label)
                        .font(size == .regular ? VFont.bodyMediumDefault : VFont.labelDefault)
                }
                .foregroundStyle(foregroundColor)
                .padding(.horizontal, size == .regular ? VSpacing.md : VSpacing.sm)
                .frame(height: zoneHeight)
                .background(zoneBackgroundColor(isHovered: isPrimaryHovered))
            }
            .buttonStyle(.plain)
            .onHover { hovering in
                isPrimaryHovered = isDisabled ? false : hovering
            }
            .pointerCursor()

            // Divider
            divider

            // Dropdown zone
            dropdownZone
        }
        .fixedSize()
        .clipShape(shape)
        .overlay(
            shape.strokeBorder(
                borderColor,
                lineWidth: borderLineWidth
            )
        )
        .contentShape(shape)
        .disabled(isDisabled)
        .accessibilityElement(children: .contain)
        .animation(VAnimation.fast, value: isPrimaryHovered)
        .animation(VAnimation.fast, value: isDropdownHovered)
        .optionalSplitButtonAccessibilityID(accessibilityID)
        #if os(macOS)
        .overlay {
            GeometryReader { geo in
                Color.clear
                    .onAppear { buttonFrame = geo.frame(in: .global) }
                    .onChange(of: geo.frame(in: .global)) { _, newFrame in
                        buttonFrame = newFrame
                    }
            }
        }
        #endif
    }

    // MARK: - Dropdown Zone

    @ViewBuilder
    private var dropdownZone: some View {
        #if os(macOS)
        if chevronDirection == .up {
            upwardDropdownZone
        } else {
            defaultDropdownZone
        }
        #else
        defaultDropdownZone
        #endif
    }

    /// Default dropdown using SwiftUI Menu.
    private var defaultDropdownZone: some View {
        ZStack(alignment: .center) {
            zoneBackgroundColor(isHovered: isDropdownHovered)
                .frame(width: dropdownWidth, height: zoneHeight)

            VIconView(chevronIcon, size: 11)
                .foregroundStyle(foregroundColor)
                .frame(width: dropdownWidth, height: zoneHeight)
                .allowsHitTesting(false)

            Menu {
                menuContent()
            } label: {
                Color.clear
                    .frame(width: dropdownWidth, height: zoneHeight)
                    .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .accessibilityLabel("\(label) options")
        }
        .frame(width: dropdownWidth, height: zoneHeight)
        .onHover { hovering in
            isDropdownHovered = isDisabled ? false : hovering
        }
        .pointerCursor()
    }

    #if os(macOS)
    /// Upward dropdown using VMenuPanel, anchored above the button.
    private var upwardDropdownZone: some View {
        ZStack(alignment: .center) {
            zoneBackgroundColor(isHovered: isDropdownHovered)
                .frame(width: dropdownWidth, height: zoneHeight)

            VIconView(.chevronUp, size: 11)
                .foregroundStyle(foregroundColor)
                .frame(width: dropdownWidth, height: zoneHeight)
                .allowsHitTesting(false)

            Button {
                if isMenuOpen {
                    activePanel?.close()
                    activePanel = nil
                    isMenuOpen = false
                } else {
                    showMenuAbove()
                }
            } label: {
                Color.clear
                    .frame(width: dropdownWidth, height: zoneHeight)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(label) options")
        }
        .frame(width: dropdownWidth, height: zoneHeight)
        .onHover { hovering in
            isDropdownHovered = isDisabled ? false : hovering
        }
        .pointerCursor()
    }

    private func showMenuAbove() {
        guard !isMenuOpen else { return }
        isMenuOpen = true

        guard let window = NSApp.keyWindow ?? NSApp.windows.first(where: { $0.isVisible }) else {
            isMenuOpen = false
            return
        }

        // Convert the button's top-left from SwiftUI (y-down) to screen (y-up) coordinates.
        let topLeftInWindow = CGPoint(x: buttonFrame.minX, y: buttonFrame.minY)
        let screenPoint = window.convertPoint(toScreen: NSPoint(
            x: topLeftInWindow.x,
            y: window.frame.height - topLeftInWindow.y
        ))

        // Compute button rect in screen coordinates for the excludeRect so
        // clicks on the button itself don't dismiss the menu.
        let buttonScreenOrigin = window.convertPoint(toScreen: NSPoint(
            x: buttonFrame.minX,
            y: window.frame.height - buttonFrame.maxY
        ))
        let buttonScreenRect = CGRect(
            origin: buttonScreenOrigin,
            size: CGSize(width: buttonFrame.width, height: buttonFrame.height)
        )

        let appearance = window.effectiveAppearance
        activePanel = VMenuPanel.show(
            at: screenPoint,
            anchor: .above,
            sourceWindow: window,
            sourceAppearance: appearance,
            excludeRect: buttonScreenRect
        ) {
            VMenu {
                menuContent()
            }
        } onDismiss: {
            isMenuOpen = false
            activePanel = nil
        }
    }
    #endif

    // MARK: - Divider

    @ViewBuilder
    private var divider: some View {
        switch style {
        case .primary, .danger:
            ZStack {
                Rectangle()
                    .fill(filledBaseColor)
                    .frame(width: 1 + 2, height: zoneHeight)
                Rectangle()
                    .fill(VColor.auxWhite.opacity(0.3))
                    .frame(width: 1, height: zoneHeight)
            }
        case .outlined, .dangerOutline:
            Rectangle()
                .fill(borderColor)
                .frame(width: 1, height: zoneHeight)
        case .ghost, .dangerGhost:
            Rectangle()
                .fill(VColor.borderBase)
                .frame(width: 1, height: zoneHeight)
        case .contrast:
            Rectangle()
                .fill(VColor.auxWhite.opacity(0.3))
                .frame(width: 1, height: zoneHeight)
        }
    }

    // MARK: - Colors

    private var filledBaseColor: Color {
        switch style {
        case .primary: return VColor.primaryBase
        case .danger: return VColor.systemNegativeStrong
        default: return .clear
        }
    }

    private func zoneBackgroundColor(isHovered: Bool) -> Color {
        guard !isDisabled else {
            switch style {
            case .primary, .danger, .contrast:
                return VColor.primaryDisabled
            default:
                return .clear
            }
        }

        switch style {
        case .primary:
            return isHovered ? VColor.primaryHover : VColor.primaryBase
        case .danger:
            return isHovered ? VColor.systemNegativeHover : VColor.systemNegativeStrong
        case .outlined, .dangerOutline:
            return isHovered ? VColor.surfaceBase : .clear
        case .ghost, .dangerGhost:
            return isHovered ? VColor.surfaceBase : .clear
        case .contrast:
            return isHovered ? VColor.contentSecondary : VColor.contentDefault
        }
    }

    private var foregroundColor: Color {
        guard !isDisabled else { return VColor.contentDisabled }
        switch style {
        case .primary, .contrast:
            return VColor.contentInset
        case .danger:
            return VColor.auxWhite
        case .outlined, .ghost:
            return VColor.primaryBase
        case .dangerOutline, .dangerGhost:
            return VColor.systemNegativeStrong
        }
    }

    private var borderColor: Color {
        guard !isDisabled else {
            switch style {
            case .outlined, .dangerOutline, .ghost, .dangerGhost:
                return VColor.primaryDisabled
            default:
                return .clear
            }
        }
        switch style {
        case .outlined:
            return VColor.primaryBase
        case .dangerOutline:
            return VColor.systemNegativeStrong
        case .ghost:
            return VColor.borderBase
        case .dangerGhost:
            return VColor.borderBase
        default:
            return .clear
        }
    }

    private var borderLineWidth: CGFloat {
        switch style {
        case .outlined, .dangerOutline: return 2
        case .ghost, .dangerGhost: return 1
        default: return 0
        }
    }
}

private extension View {
    @ViewBuilder
    func optionalSplitButtonAccessibilityID(_ identifier: String?) -> some View {
        if let identifier {
            self.accessibilityIdentifier(identifier)
        } else {
            self
        }
    }
}

// MARK: - AnyInsettableShape

/// Type-erased `InsettableShape` so VSplitButton can switch between
/// `Capsule` and `RoundedRectangle` at runtime while still using
/// `strokeBorder` (which requires `InsettableShape`).
private struct AnyInsettableShape: InsettableShape {
    private let _path: (CGRect) -> Path
    private let _sizeThatFits: (ProposedViewSize) -> CGSize
    private let _inset: (CGFloat) -> AnyInsettableShape

    init<S: InsettableShape>(_ shape: S) {
        _path = shape.path
        _sizeThatFits = shape.sizeThatFits
        _inset = { AnyInsettableShape(shape.inset(by: $0)) }
    }

    func path(in rect: CGRect) -> Path { _path(rect) }
    func sizeThatFits(_ proposal: ProposedViewSize) -> CGSize { _sizeThatFits(proposal) }
    func inset(by amount: CGFloat) -> AnyInsettableShape { _inset(amount) }
}
