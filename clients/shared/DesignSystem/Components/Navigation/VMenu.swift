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
        VStack(alignment: .leading, spacing: 0) {
            content
        }
        .padding(VSpacing.sm)
        .frame(width: width)
        .background(VColor.surfaceLift)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .shadow(color: VColor.auxBlack.opacity(0.1), radius: 1.5, x: 0, y: 1)
        .shadow(color: VColor.auxBlack.opacity(0.1), radius: 6, x: 0, y: 4)
    }
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
        size: VMenuItemSize = .compact,
        action: @escaping () -> Void,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.icon = icon
        self.label = label
        self.isActive = isActive
        self.size = size
        self.action = action
        self.trailing = trailing()
    }

    private var iconColor: Color {
        isActive ? VColor.primaryActive : VColor.primaryBase
    }

    private var textColor: Color {
        isActive ? VColor.contentEmphasized : VColor.contentSecondary
    }

    public var body: some View {
        if size == .regular {
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
        size: VMenuItemSize = .compact,
        action: @escaping () -> Void
    ) {
        self.init(icon: icon, label: label, isActive: isActive, size: size, action: action) {
            EmptyView()
        }
    }
}

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
