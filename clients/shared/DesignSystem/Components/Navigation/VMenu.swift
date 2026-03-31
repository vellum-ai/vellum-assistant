import SwiftUI

// MARK: - VMenu Dismiss Environment

/// Environment key injected by `.vContextMenu` so that `VMenuItem` can
/// auto-dismiss the hosting panel when an action is tapped. When `nil`
/// (the default), VMenuItem does not auto-dismiss — callers manage dismissal.
private struct VMenuDismissKey: EnvironmentKey {
    static let defaultValue: (() -> Void)? = nil
}

public extension EnvironmentValues {
    var vMenuDismiss: (() -> Void)? {
        get { self[VMenuDismissKey.self] }
        set { self[VMenuDismissKey.self] = newValue }
    }
}

// MARK: - VMenu Coordinator Environment

#if os(macOS)
private struct VMenuCoordinatorKey: EnvironmentKey {
    static let defaultValue: VMenuCoordinator? = nil
}

public extension EnvironmentValues {
    var vMenuCoordinator: VMenuCoordinator? {
        get { self[VMenuCoordinatorKey.self] }
        set { self[VMenuCoordinatorKey.self] = newValue }
    }
}
#endif

// MARK: - VMenu Parent Width Environment

/// Injected by `VMenu` so `VSubMenuItem` can inherit the parent menu's width.
private struct VMenuParentWidthKey: EnvironmentKey {
    static let defaultValue: CGFloat? = nil
}

public extension EnvironmentValues {
    var vMenuParentWidth: CGFloat? {
        get { self[VMenuParentWidthKey.self] }
        set { self[VMenuParentWidthKey.self] = newValue }
    }
}

// MARK: - VMenu

/// A reusable popover container that provides consistent chrome (background, corner radius, shadow)
/// matching the drawer pattern used throughout the app. Callers are responsible for their own
/// transitions and presentation logic.
///
/// Usage:
/// ```swift
/// VMenu(width: 200) {
///     VMenuItem(icon: VIcon.copy.rawValue, label: "Copy") { handleCopy() }
///     VMenuDivider()
///     VMenuItem(label: "Delete") { handleDelete() }
/// }
/// ```
public struct VMenu<Content: View>: View {
    public let width: CGFloat?
    public let content: Content

    public init(
        width: CGFloat? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.width = width
        self.content = content()
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            content
        }
        .padding(VSpacing.sm)
        .frame(width: width)
        .environment(\.vMenuParentWidth, width)
        .background(VColor.surfaceLift)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .shadow(color: VColor.auxBlack.opacity(0.1), radius: 1.5, x: 0, y: 1)
        .shadow(color: VColor.auxBlack.opacity(0.1), radius: 6, x: 0, y: 4)
    }
}

// MARK: - VMenuItemVariant

/// Visual variants for `VMenuItem`.
public enum VMenuItemVariant {
    /// Standard menu item with default icon and text colors.
    case `default`
    /// Destructive action — icon and text use `VColor.systemNegativeStrong`.
    case destructive
}

// MARK: - VMenuItemSize

/// Size variants for `VMenuItem`.
public enum VMenuItemSize {
    /// Compact menu item — 13pt DM Sans, matching sidebar conversation rows.
    case compact
    /// Regular menu item — delegates to `VNavItem` (14pt `VFont.bodyMediumDefault`).
    case regular

    fileprivate var font: Font { self == .compact ? VFont.menuCompact : VFont.bodyMediumDefault }
}

// MARK: - VMenuItem

/// A tappable menu row with optional leading icon, active state, and trailing content.
///
/// Defaults to `.compact` size (13pt) to match sidebar conversation rows. Use `.regular`
/// for 14pt rows that match `VNavItem`.
///
/// Usage:
/// ```swift
/// VMenuItem(icon: VIcon.settings.rawValue, label: "Settings") { openSettings() }
///
/// // Destructive action (red icon and text):
/// VMenuItem(icon: VIcon.trash.rawValue, label: "Delete", variant: .destructive) { handleDelete() }
///
/// // Regular size (14pt, same as VNavItem):
/// VMenuItem(icon: VIcon.settings.rawValue, label: "Settings", size: .regular) { openSettings() }
///
/// // With trailing content:
/// VMenuItem(label: "Theme", isActive: true) { toggleTheme() } trailing: {
///     Text("Dark").font(VFont.labelDefault).foregroundStyle(VColor.contentTertiary)
/// }
/// ```
public struct VMenuItem<Trailing: View>: View {
    public let icon: String?
    public let label: String
    public let isActive: Bool
    public let variant: VMenuItemVariant
    public let size: VMenuItemSize
    public let action: () -> Void
    public let trailing: Trailing

    @Environment(\.vMenuDismiss) private var dismissMenu
    @Environment(\.isEnabled) private var isEnabled
    @State private var isHovered = false

    public init(
        icon: String? = nil,
        label: String,
        isActive: Bool = false,
        variant: VMenuItemVariant = .default,
        size: VMenuItemSize = .compact,
        action: @escaping () -> Void,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.icon = icon
        self.label = label
        self.isActive = isActive
        self.variant = variant
        self.size = size
        self.action = action
        self.trailing = trailing()
    }

    private var iconColor: Color {
        if variant == .destructive { return VColor.systemNegativeStrong }
        return isActive ? VColor.primaryActive : VColor.primaryBase
    }

    private var textColor: Color {
        if variant == .destructive { return VColor.systemNegativeStrong }
        return isActive ? VColor.contentEmphasized : VColor.contentSecondary
    }

    public var body: some View {
        if size == .regular {
            let _ = {
                if variant != .default {
                    assertionFailure("VMenuItem: variant \(variant) is not supported with .regular size (delegates to VNavItem)")
                }
            }()
            VNavItem(
                icon: icon,
                label: label,
                isActive: isActive,
                isExpanded: true,
                action: { dismissMenu?(); action() }
            ) {
                trailing
            }
        } else {
            HStack(spacing: VSpacing.xs) {
                if let icon {
                    VIconView(.resolve(icon), size: VSize.iconDefault)
                        .foregroundStyle(iconColor)
                        .frame(width: VSize.iconSlot, height: VSize.iconSlot)
                }
                Text(label)
                    .font(size.font)
                    .foregroundStyle(isEnabled ? textColor : VColor.contentDisabled)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .allowsHitTesting(false)
                Spacer()
                trailing
            }
            .padding(.leading, VSpacing.xs)
            .padding(.trailing, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)
            .frame(minHeight: VSize.rowMinHeight)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                isActive ? VColor.surfaceActive :
                isHovered && isEnabled ? VColor.surfaceBase :
                Color.clear
            )
            .animation(VAnimation.fast, value: isHovered)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .contentShape(Rectangle())
            .onTapGesture { guard isEnabled else { return }; dismissMenu?(); action() }
            .onHover { isHovered = $0 }
            .pointerCursor()
        }
    }
}

// MARK: - VMenuItem convenience (no trailing)

public extension VMenuItem where Trailing == EmptyView {
    /// Menu item with no trailing content.
    init(
        icon: String? = nil,
        label: String,
        isActive: Bool = false,
        variant: VMenuItemVariant = .default,
        size: VMenuItemSize = .compact,
        action: @escaping () -> Void
    ) {
        self.init(icon: icon, label: label, isActive: isActive, variant: variant, size: size, action: action) {
            EmptyView()
        }
    }
}

// MARK: - VSubMenuItem

#if os(macOS)
/// A menu item that opens a cascading submenu panel on hover or click.
///
/// Renders identically to `VMenuItem` but with a trailing chevron indicator.
/// On hover (after 150ms) or click, opens a child `VMenuPanel` anchored to
/// the item's trailing edge. Requires a `VMenuCoordinator` in the environment
/// (automatically provided by `VMenuPanel.show()` and `.vContextMenu`).
///
/// Usage:
/// ```swift
/// VSubMenuItem(icon: VIcon.folder.rawValue, label: "Move to") {
///     VMenuItem(label: "Work") { moveToWork() }
///     VMenuItem(label: "Personal") { moveToPersonal() }
/// }
/// ```
public struct VSubMenuItem<Content: View>: View {
    public let icon: String?
    public let label: String
    public let width: CGFloat?
    public let content: () -> Content

    @Environment(\.vMenuCoordinator) private var coordinator
    @Environment(\.vMenuParentWidth) private var parentWidth
    @Environment(\.isEnabled) private var isEnabled
    @State private var isHovered = false
    @State private var hoverTimer: DispatchWorkItem?

    public init(
        icon: String? = nil,
        label: String,
        width: CGFloat? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.icon = icon
        self.label = label
        self.width = width
        self.content = content
    }

    private var effectiveWidth: CGFloat? {
        width ?? parentWidth
    }

    public var body: some View {
        HStack(spacing: VSpacing.xs) {
            if let icon {
                VIconView(.resolve(icon), size: VSize.iconDefault)
                    .foregroundStyle(VColor.primaryBase)
                    .frame(width: VSize.iconSlot, height: VSize.iconSlot)
            }
            Text(label)
                .font(VFont.menuCompact)
                .foregroundStyle(isEnabled ? VColor.contentSecondary : VColor.contentDisabled)
                .lineLimit(1)
                .truncationMode(.tail)
                .allowsHitTesting(false)
            Spacer()
            VIconView(.chevronRight, size: 10)
                .foregroundStyle(VColor.contentTertiary)
        }
        .padding(.leading, VSpacing.xs)
        .padding(.trailing, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .frame(minHeight: VSize.rowMinHeight)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isHovered && isEnabled ? VColor.surfaceBase : Color.clear)
        .animation(VAnimation.fast, value: isHovered)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .contentShape(Rectangle())
        .background(ScreenRectReader(rect: $screenRect))
        .onHover { hovering in
            isHovered = hovering
            guard isEnabled else { return }
            if hovering {
                hoverTimer?.cancel()
                let work = DispatchWorkItem { [weak coordinator] in
                    showChild(coordinator: coordinator)
                }
                hoverTimer = work
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: work)
            } else {
                hoverTimer?.cancel()
                hoverTimer = nil
                // Only start grace timer if the mouse isn't already inside
                // the child panel. AppKit fires mouseExited on the parent item
                // when the mouse enters a sibling window (the child panel),
                // but the child's tracking area may not have fired mouseEntered
                // yet if it was just created.
                if let coordinator, coordinator.hasChild,
                   let childPanel = coordinator.panels.last {
                    let mouseLocation = NSEvent.mouseLocation
                    let locationInPanel = childPanel.convertPoint(fromScreen: mouseLocation)
                    let panelBounds = childPanel.contentView?.bounds ?? .zero
                    if panelBounds.contains(locationInPanel) {
                        return // Mouse is in child panel — don't start timer
                    }
                }
                coordinator?.startGraceTimer()
            }
        }
        .onTapGesture {
            guard isEnabled else { return }
            hoverTimer?.cancel()
            showChild(coordinator: coordinator)
        }
        .pointerCursor()
        .accessibilityElement()
        .accessibilityLabel(label)
        .accessibilityHint("Opens submenu")
        .accessibilityAddTraits(.isButton)
    }

    @State private var screenRect: CGRect = .zero

    private func showChild(coordinator: VMenuCoordinator?) {
        guard let coordinator, screenRect != .zero else { return }

        let menuWidth = effectiveWidth
        let contentBuilder = content
        coordinator.showChild(
            anchoredTo: screenRect,
            width: menuWidth,
            sourceAppearance: NSApp.keyWindow?.effectiveAppearance
        ) {
            VMenu(width: menuWidth) {
                contentBuilder()
            }
        }
    }
}

/// Invisible NSView that reads its own screen-space frame and writes it to a SwiftUI binding.
/// This gives the correct screen coordinates (origin bottom-left, y-up) regardless of
/// which screen or window the view is on — unlike SwiftUI's `.global` coordinate space
/// which is window-relative.
private struct ScreenRectReader: NSViewRepresentable {
    @Binding var rect: CGRect

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        view.setAccessibilityElement(false)
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async {
            guard let window = nsView.window else { return }
            let viewFrame = nsView.convert(nsView.bounds, to: nil)
            let screenFrame = window.convertToScreen(viewFrame)
            if screenFrame != rect {
                rect = screenFrame
            }
        }
    }
}
#else
/// iOS fallback: delegates to SwiftUI's native `Menu` for submenu behavior.
public struct VSubMenuItem<Content: View>: View {
    public let icon: String?
    public let label: String
    public let width: CGFloat?
    public let content: () -> Content

    public init(
        icon: String? = nil,
        label: String,
        width: CGFloat? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.icon = icon
        self.label = label
        self.width = width
        self.content = content
    }

    public var body: some View {
        Menu(label) {
            content()
        }
    }
}
#endif

// MARK: - VMenuSection

/// Groups menu items with an optional header label and divider.
///
/// Usage:
/// ```swift
/// VMenuSection(header: "Navigation") {
///     VMenuItem(label: "Home") { goHome() }
///     VMenuItem(label: "Settings") { openSettings() }
/// }
/// ```
public struct VMenuSection<Content: View>: View {
    public let header: String?
    public let content: Content

    public init(
        header: String? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.header = header
        self.content = content()
    }

    public var body: some View {
        if let header {
            Text(header)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentDisabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, VSpacing.lg)
                .padding(.top, VSpacing.sm)
                .padding(.bottom, VSpacing.xs)
        }

        VColor.surfaceBase.frame(height: 1)
            .padding(.horizontal, VSpacing.xs)

        content
    }
}

// MARK: - VMenuDivider

/// A simple horizontal divider for separating menu items.
public struct VMenuDivider: View {
    public init() {}

    public var body: some View {
        VColor.surfaceBase.frame(height: 1)
            .padding(.horizontal, VSpacing.xs)
            .padding(.vertical, VSpacing.xs)
    }
}

// MARK: - VMenuCustomRow

/// Escape hatch for embedding arbitrary content in a menu with consistent horizontal alignment.
///
/// Usage:
/// ```swift
/// VMenuCustomRow {
///     DrawerThemeToggle()
/// }
/// ```
public struct VMenuCustomRow<Content: View>: View {
    public let content: Content

    public init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    public var body: some View {
        content
            .padding(.horizontal, VSpacing.sm)
    }
}
