import Combine
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

// MARK: - VMenu Panel Level Environment

/// The nesting level of the current VMenu panel (0 = root, 1 = child submenu).
/// Injected by VMenuPanel so items know which level they belong to for keyboard focus registration.
private struct VMenuPanelLevelKey: EnvironmentKey {
    static let defaultValue: Int = 0
}

public extension EnvironmentValues {
    var vMenuPanelLevel: Int {
        get { self[VMenuPanelLevelKey.self] }
        set { self[VMenuPanelLevelKey.self] = newValue }
    }
}

// MARK: - VMenu Focused Item ID Environment

/// The UUID of the currently keyboard-focused menu item, or `nil` when mouse-driven.
/// Set by VMenu's `.onKeyPress` handlers; read by VMenuItem/VSubMenuItem for the highlight.
/// Cross-platform — always `nil` on non-macOS (no keyboard navigation for custom menus).
private struct VMenuFocusedItemIDKey: EnvironmentKey {
    static let defaultValue: UUID? = nil
}

extension EnvironmentValues {
    var vMenuFocusedItemID: UUID? {
        get { self[VMenuFocusedItemIDKey.self] }
        set { self[VMenuFocusedItemIDKey.self] = newValue }
    }
}

// MARK: - Item Registration Preference Key

/// Data reported by each interactive menu item (VMenuItem, VSubMenuItem) so VMenu
/// can assign sequential indices and update the coordinator's item registry.
struct VMenuItemRegistration: Equatable {
    let id: UUID
    let isSubmenu: Bool
}

/// Preference key that collects item registrations in layout order (top to bottom).
/// VMenu reads this via `onPreferenceChange` to populate the coordinator's `itemOrder`.
struct VMenuItemRegistrationKey: PreferenceKey {
    static var defaultValue: [VMenuItemRegistration] = []
    static func reduce(value: inout [VMenuItemRegistration], nextValue: () -> [VMenuItemRegistration]) {
        value.append(contentsOf: nextValue())
    }
}

// MARK: - NSView Capture for VoiceOver Bridge

/// Invisible NSViewRepresentable that captures its underlying NSView reference and registers
/// it with the VMenuCoordinator. When keyboard focus moves to this item, the coordinator
/// uses the NSView to post `NSAccessibility.post(element:notification:.focusedUIElementChanged)`
/// so VoiceOver tracks keyboard navigation.
struct VMenuItemNSViewCapture: NSViewRepresentable {
    let itemID: UUID
    let level: Int
    let coordinator: VMenuCoordinator?

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        view.setAccessibilityElement(false)
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        coordinator?.registerItemNSView(level: level, id: itemID, view: nsView)
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
    public let maxHeight: CGFloat?
    public let content: Content

    #if os(macOS)
    @Environment(\.vMenuCoordinator) private var coordinator
    @Environment(\.vMenuPanelLevel) private var panelLevel
    @FocusState private var isMenuFocused: Bool
    /// UUID of the item currently highlighted via keyboard. `nil` = mouse-driven (no highlight).
    @State private var focusedItemID: UUID?
    /// Ordered list of item UUIDs collected from the preference key.
    @State private var registeredIDs: [UUID] = []
    #endif

    public init(
        width: CGFloat? = nil,
        maxHeight: CGFloat? = nil,
        @ViewBuilder content: () -> Content
    ) {
        self.width = width
        self.maxHeight = maxHeight
        self.content = content()
    }

    /// The menu's inner content, optionally wrapped in a vertical `ScrollView` when
    /// `maxHeight` is set. Keeping the scroll wrapper conditional preserves the
    /// intrinsic-size path for existing callers that don't opt into a height cap.
    @ViewBuilder
    private var innerContent: some View {
        let stack = VStack(alignment: .leading, spacing: VSpacing.xs) {
            content
        }
        .padding(VSpacing.sm)

        if maxHeight != nil {
            ScrollView(.vertical) { stack }
        } else {
            stack
        }
    }

    public var body: some View {
        innerContent
        .frame(width: width)
        .frame(maxHeight: maxHeight)
        .environment(\.vMenuParentWidth, width)
        #if os(macOS)
        .environment(\.vMenuFocusedItemID, focusedItemID)
        #endif
        .background(VColor.surfaceLift)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .shadow(color: VColor.auxBlack.opacity(0.1), radius: 1.5, x: 0, y: 1)
        .shadow(color: VColor.auxBlack.opacity(0.1), radius: 6, x: 0, y: 4)
        #if os(macOS)
        // --- SwiftUI-native keyboard focus (WWDC23 "The SwiftUI cookbook for focus") ---
        // Primary key-handling path: the VStack receives focus and .onKeyPress fires.
        // Fallback: if focus is lost, VMenuPanel.keyDown catches events via the responder chain.
        // Reference: https://developer.apple.com/videos/play/wwdc2023/10162/
        .focusable()
        .focused($isMenuFocused)
        .focusEffectDisabled()
        .onKeyPress(keys: [.upArrow, .downArrow, .leftArrow, .rightArrow, .return, .space]) { keyPress in
            handleMenuKeyPress(keyPress)
        }
        .task {
            // Brief delay so the hosting NSPanel's focus system is ready.
            try? await Task.sleep(nanoseconds: 50_000_000)
            guard !Task.isCancelled else { return }
            isMenuFocused = true
            // If this child menu was opened via keyboard (→ arrow), auto-focus the first item.
            if panelLevel > 0, coordinator?.consumePendingChildFocus() == true, !registeredIDs.isEmpty {
                moveMenuFocus(direction: 1)
            }
        }
        .onPreferenceChange(VMenuItemRegistrationKey.self) { registrations in
            registeredIDs = registrations.map(\.id)
            coordinator?.updateItemOrder(level: panelLevel, ids: registeredIDs)
        }
        .onReceive(coordinator?.clearFocusAnyPublisher ?? Empty<Void, Never>().eraseToAnyPublisher()) { _ in
            focusedItemID = nil
        }
        .onReceive(coordinator?.focusChangeAnyPublisher ?? Empty<(level: Int, id: UUID?), Never>().eraseToAnyPublisher()) { change in
            guard change.level == panelLevel else { return }
            focusedItemID = change.id
        }
        #endif
    }

    // MARK: - Keyboard Navigation Helpers

    #if os(macOS)
    /// Unified key-press handler dispatching to the appropriate navigation action.
    private func handleMenuKeyPress(_ keyPress: KeyPress) -> KeyPress.Result {
        if keyPress.key == .upArrow {
            moveMenuFocus(direction: -1)
            return .handled
        } else if keyPress.key == .downArrow {
            moveMenuFocus(direction: 1)
            return .handled
        } else if keyPress.key == .return || keyPress.key == .space {
            return activateMenuFocus()
        } else if keyPress.key == .rightArrow {
            return openMenuSubmenu()
        } else if keyPress.key == .leftArrow {
            return closeMenuSubmenu()
        }
        return .ignored
    }

    /// Move keyboard focus up or down by `direction` (+1 = down, -1 = up), wrapping around.
    private func moveMenuFocus(direction: Int) {
        coordinator?.recordKeyboardEvent()
        guard !registeredIDs.isEmpty else { return }

        let currentIndex: Int
        if let fid = focusedItemID, let idx = registeredIDs.firstIndex(of: fid) {
            currentIndex = idx
        } else {
            currentIndex = direction > 0 ? -1 : registeredIDs.count
        }

        let count = registeredIDs.count
        let next = (currentIndex + direction + count) % count
        focusedItemID = registeredIDs[next]

        // Keep coordinator in sync for the VoiceOver bridge.
        coordinator?.focusedIndex[panelLevel] = next
        coordinator?.postVoiceOverFocusNotification(level: panelLevel)
    }

    /// Activate the currently focused item (Enter / Space).
    private func activateMenuFocus() -> KeyPress.Result {
        guard let fid = focusedItemID,
              coordinator?.isItemEnabled(level: panelLevel, id: fid) ?? true,
              let action = coordinator?.itemActions[panelLevel]?[fid] else {
            return .ignored
        }
        action()
        return .handled
    }

    /// Open the submenu of the currently focused VSubMenuItem (→ arrow).
    private func openMenuSubmenu() -> KeyPress.Result {
        guard let fid = focusedItemID,
              coordinator?.isItemEnabled(level: panelLevel, id: fid) ?? true,
              let action = coordinator?.submenuActions[panelLevel]?[fid] else {
            return .ignored
        }
        coordinator?.pendingChildFocus = true
        action()
        return .handled
    }

    /// Close the current submenu (← arrow). Only valid when panelLevel > 0.
    private func closeMenuSubmenu() -> KeyPress.Result {
        guard panelLevel > 0 else { return .ignored }
        coordinator?.dismissChild()
        return .handled
    }
    #endif
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

    fileprivate var font: Font { VFont.bodyMediumDefault }
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
    public let accessibilityValueText: String?
    public let action: () -> Void
    public let trailing: Trailing

    @Environment(\.vMenuDismiss) private var dismissMenu
    @Environment(\.isEnabled) private var isEnabled
    @State private var isHovered = false

    #if os(macOS)
    @Environment(\.vMenuCoordinator) private var coordinator
    @Environment(\.vMenuPanelLevel) private var panelLevel
    @Environment(\.vMenuFocusedItemID) private var menuFocusedItemID
    @State private var itemID = UUID()

    /// Whether this item is currently highlighted via keyboard navigation.
    /// Derived from VMenu's `@State focusedItemID` passed through environment.
    private var isKeyboardFocused: Bool {
        menuFocusedItemID == itemID
    }
    #endif

    public init(
        icon: String? = nil,
        label: String,
        isActive: Bool = false,
        variant: VMenuItemVariant = .default,
        size: VMenuItemSize = .compact,
        accessibilityValue: String? = nil,
        action: @escaping () -> Void,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.icon = icon
        self.label = label
        self.isActive = isActive
        self.variant = variant
        self.size = size
        self.accessibilityValueText = accessibilityValue
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

    /// Background color for the item, incorporating active state, keyboard focus, and mouse hover.
    private var highlightBackground: Color {
        if isActive { return VColor.surfaceActive }
        #if os(macOS)
        if isKeyboardFocused { return VColor.systemPositiveWeak }
        #endif
        if isHovered && isEnabled { return VColor.surfaceBase }
        return .clear
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
                isKeyboardFocused: {
                    #if os(macOS)
                    return isKeyboardFocused
                    #else
                    return false
                    #endif
                }(),
                action: { dismissMenu?(); action() }
            ) {
                trailing
            }
            .accessibilityValue(accessibilityValueText ?? "")
            #if os(macOS)
            .preference(key: VMenuItemRegistrationKey.self, value: [VMenuItemRegistration(id: itemID, isSubmenu: false)])
            .background(VMenuItemNSViewCapture(itemID: itemID, level: panelLevel, coordinator: coordinator))
            .onAppear {
                coordinator?.registerItemAction(level: panelLevel, id: itemID) {
                    dismissMenu?(); action()
                }
                coordinator?.registerItemEnabled(level: panelLevel, id: itemID, isEnabled: isEnabled)
            }
            .onChange(of: isEnabled) { _, newValue in
                coordinator?.registerItemEnabled(level: panelLevel, id: itemID, isEnabled: newValue)
            }
            #endif
        } else {
            HStack(spacing: VSpacing.xs) {
                if let icon {
                    VIconView(.resolve(icon), size: VSize.iconDefault)
                        .foregroundStyle(isEnabled ? iconColor : VColor.contentDisabled)
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
            .background(highlightBackground)
            .animation(VAnimation.fast, value: isHovered)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
            .contentShape(Rectangle())
            .onTapGesture { guard isEnabled else { return }; dismissMenu?(); action() }
            .onHover { isHovered = $0 }
            .pointerCursor()
            .accessibilityElement(children: .combine)
            .accessibilityLabel(label)
            .accessibilityAddTraits(.isButton)
            .accessibilityAddTraits(isActive ? [.isSelected] : [])
            .accessibilityRemoveTraits(isEnabled ? [] : [.isButton])
            .accessibilityValue(accessibilityValueText ?? "")
            .accessibilityAction { guard isEnabled else { return }; dismissMenu?(); action() }
            #if os(macOS)
            .preference(key: VMenuItemRegistrationKey.self, value: [VMenuItemRegistration(id: itemID, isSubmenu: false)])
            .background(VMenuItemNSViewCapture(itemID: itemID, level: panelLevel, coordinator: coordinator))
            .onAppear {
                coordinator?.registerItemAction(level: panelLevel, id: itemID) {
                    dismissMenu?(); action()
                }
                coordinator?.registerItemEnabled(level: panelLevel, id: itemID, isEnabled: isEnabled)
            }
            .onChange(of: isEnabled) { _, newValue in
                coordinator?.registerItemEnabled(level: panelLevel, id: itemID, isEnabled: newValue)
            }
            #endif
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
        accessibilityValue: String? = nil,
        action: @escaping () -> Void
    ) {
        self.init(icon: icon, label: label, isActive: isActive, variant: variant, size: size, accessibilityValue: accessibilityValue, action: action) {
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
    @Environment(\.vMenuPanelLevel) private var panelLevel
    @Environment(\.isEnabled) private var isEnabled
    @State private var isHovered = false
    @State private var hoverTimer: DispatchWorkItem?
    @State private var itemID = UUID()
    @Environment(\.vMenuFocusedItemID) private var menuFocusedItemID

    /// Whether this item is currently highlighted via keyboard navigation.
    private var isKeyboardFocused: Bool {
        menuFocusedItemID == itemID
    }

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

    /// Background color incorporating keyboard focus and mouse hover.
    private var highlightBackground: Color {
        #if os(macOS)
        if isKeyboardFocused { return VColor.systemPositiveWeak }
        #endif
        if isHovered && isEnabled { return VColor.surfaceBase }
        return .clear
    }

    public var body: some View {
        HStack(spacing: VSpacing.xs) {
            if let icon {
                VIconView(.resolve(icon), size: VSize.iconDefault)
                    .foregroundStyle(isEnabled ? VColor.primaryBase : VColor.contentDisabled)
                    .frame(width: VSize.iconSlot, height: VSize.iconSlot)
            }
            Text(label)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(isEnabled ? VColor.contentSecondary : VColor.contentDisabled)
                .lineLimit(1)
                .truncationMode(.tail)
                .allowsHitTesting(false)
            Spacer()
            VIconView(.chevronRight, size: 10)
                .foregroundStyle(isEnabled ? VColor.contentTertiary : VColor.contentDisabled)
        }
        .padding(.leading, VSpacing.xs)
        .padding(.trailing, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .frame(minHeight: VSize.rowMinHeight)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(highlightBackground)
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
        .accessibilityAction {
            guard isEnabled else { return }
            hoverTimer?.cancel()
            showChild(coordinator: coordinator)
        }
        .preference(key: VMenuItemRegistrationKey.self, value: [VMenuItemRegistration(id: itemID, isSubmenu: true)])
        .background(VMenuItemNSViewCapture(itemID: itemID, level: panelLevel, coordinator: coordinator))
        .onAppear {
            // Register both item action (Enter/Space) and submenu action (right arrow).
            // For submenus, both trigger the same behavior: open the child panel.
            let openAction = { [weak coordinator] in
                hoverTimer?.cancel()
                showChild(coordinator: coordinator)
            }
            coordinator?.registerItemAction(level: panelLevel, id: itemID, action: openAction)
            coordinator?.registerSubmenuAction(level: panelLevel, id: itemID, action: openAction)
            coordinator?.registerItemEnabled(level: panelLevel, id: itemID, isEnabled: isEnabled)
        }
        .onChange(of: isEnabled) { _, newValue in
            coordinator?.registerItemEnabled(level: panelLevel, id: itemID, isEnabled: newValue)
        }
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
                .accessibilityAddTraits(.isHeader)
        }

        VColor.surfaceBase.frame(height: 1)
            .padding(.horizontal, VSpacing.xs)
            .accessibilityHidden(true)

        content
    }
}

// MARK: - VMenuDivider

/// A simple horizontal divider for separating menu items.
public struct VMenuDivider: View {
    public init() {}

    public var body: some View {
        VColor.borderHover.frame(height: 1)
            .padding(.horizontal, VSpacing.xs)
            .padding(.vertical, VSpacing.xs)
            .accessibilityHidden(true)
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
