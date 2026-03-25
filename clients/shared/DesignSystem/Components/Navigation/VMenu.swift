import SwiftUI

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

// MARK: - VMenuItem

/// A tappable menu row that delegates to `VSidebarRow` for consistent styling.
/// Supports an optional leading icon, active state, and trailing content.
///
/// Usage:
/// ```swift
/// VMenuItem(icon: VIcon.settings.rawValue, label: "Settings") { openSettings() }
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
    public let action: () -> Void
    public let trailing: Trailing

    public init(
        icon: String? = nil,
        label: String,
        isActive: Bool = false,
        action: @escaping () -> Void,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.icon = icon
        self.label = label
        self.isActive = isActive
        self.action = action
        self.trailing = trailing()
    }

    public var body: some View {
        VSidebarRow(
            icon: icon,
            label: label,
            isActive: isActive,
            isExpanded: true,
            action: action
        ) {
            trailing
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
        action: @escaping () -> Void
    ) {
        self.init(icon: icon, label: label, isActive: isActive, action: action) {
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
