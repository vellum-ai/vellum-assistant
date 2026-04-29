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
    @State private var dropdownFrame: CGRect = .zero
    @State private var activePanel: VMenuPanel?
    @State private var isMenuOpen = false
    /// Monotonic counter to distinguish stale dismiss handlers from swept
    /// panels. Each showMenu() increments this; the onDismiss closure
    /// captures the current value and only resets state if it still matches.
    @State private var menuGeneration: UInt = 0
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
    }

    // MARK: - Dropdown Zone

    @ViewBuilder
    private var dropdownZone: some View {
        #if os(macOS)
        macOSDropdownZone
        #else
        iOSDropdownZone
        #endif
    }

    #if !os(macOS)
    /// iOS fallback using SwiftUI's native Menu.
    private var iOSDropdownZone: some View {
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
    #endif

    #if os(macOS)
    /// macOS dropdown using VMenu + VMenuPanel for both directions.
    private var macOSDropdownZone: some View {
        ZStack(alignment: .center) {
            zoneBackgroundColor(isHovered: isDropdownHovered)
                .frame(width: dropdownWidth, height: zoneHeight)

            VIconView(chevronIcon, size: 11)
                .foregroundStyle(foregroundColor)
                .frame(width: dropdownWidth, height: zoneHeight)
                .allowsHitTesting(false)

            Button {
                if isMenuOpen {
                    activePanel?.close()
                    activePanel = nil
                    isMenuOpen = false
                } else {
                    showMenu()
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
        .overlay {
            GeometryReader { geo in
                Color.clear
                    .onAppear { dropdownFrame = geo.frame(in: .global) }
                    .onChange(of: geo.frame(in: .global)) { _, newFrame in
                        dropdownFrame = newFrame
                    }
            }
        }
    }

    private var menuAnchor: VMenuAnchorEdge {
        chevronDirection == .up ? .above : .below
    }

    private func showMenu() {
        guard !isMenuOpen else { return }
        menuGeneration &+= 1
        let currentGeneration = menuGeneration
        isMenuOpen = true

        guard let window = NSApp.keyWindow ?? NSApp.windows.first(where: { $0.isVisible }) else {
            isMenuOpen = false
            return
        }

        // Anchor point in screen coordinates (y-up).
        // .below: bottom-left of dropdown zone; .above: top-left of dropdown zone.
        let anchorY = chevronDirection == .up ? dropdownFrame.minY : dropdownFrame.maxY
        let screenPoint = window.convertPoint(toScreen: NSPoint(
            x: dropdownFrame.minX,
            y: window.frame.height - anchorY
        ))

        // Exclude only the dropdown zone so clicks on the primary action
        // half correctly dismiss the menu via VMenuPanel's click monitor.
        let dropdownScreenOrigin = window.convertPoint(toScreen: NSPoint(
            x: dropdownFrame.minX,
            y: window.frame.height - dropdownFrame.maxY
        ))
        let dropdownScreenRect = CGRect(
            origin: dropdownScreenOrigin,
            size: CGSize(width: dropdownFrame.width, height: dropdownFrame.height)
        )

        let appearance = window.effectiveAppearance
        activePanel = VMenuPanel.show(
            at: screenPoint,
            anchor: menuAnchor,
            sourceWindow: window,
            sourceAppearance: appearance,
            excludeRect: dropdownScreenRect
        ) {
            VMenu {
                menuContent()
            }
        } onDismiss: { [currentGeneration] in
            // Only reset state if this is still the active generation.
            // VMenuPanel.show() sweeps existing panels before creating a
            // new one, which fires the old panel's onDismiss synchronously.
            // Without this guard, the sweep would set isMenuOpen = false
            // while the new panel is being created, causing state desync.
            guard self.menuGeneration == currentGeneration else { return }
            isMenuOpen = false
            activePanel = nil
        }
    }
    #endif

    // MARK: - Divider

    private var isDividerVisible: Bool {
        if isPrimaryHovered || isDropdownHovered { return true }
        #if os(macOS)
        if isMenuOpen { return true }
        #endif
        return false
    }

    @ViewBuilder
    private var divider: some View {
        switch style {
        case .primary, .danger:
            ZStack {
                Rectangle()
                    .fill(filledBaseColor)
                    .frame(width: 1 + 2, height: zoneHeight)
                Rectangle()
                    .fill(VColor.auxWhite.opacity(isDividerVisible ? 0.3 : 0))
                    .frame(width: 1, height: zoneHeight)
            }
        case .outlined, .dangerOutline:
            Rectangle()
                .fill(borderColor.opacity(isDividerVisible ? 1 : 0))
                .frame(width: 1, height: zoneHeight)
        case .ghost, .dangerGhost:
            Rectangle()
                .fill(VColor.borderBase.opacity(isDividerVisible ? 1 : 0))
                .frame(width: 1, height: zoneHeight)
        case .contrast:
            Rectangle()
                .fill(VColor.auxWhite.opacity(isDividerVisible ? 0.3 : 0))
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

