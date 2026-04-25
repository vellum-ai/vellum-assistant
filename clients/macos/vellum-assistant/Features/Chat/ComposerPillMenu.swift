import SwiftUI
import VellumAssistantShared

/// A pill-shaped composer action-bar button that opens a ``VMenuPanel`` with
/// custom contents. Centralizes the trigger-frame capture, screen-coordinate
/// math, and panel lifecycle so individual pickers (e.g. ``ChatProfilePicker``,
/// ``ComposerThresholdPicker``) only need to declare their own label content
/// and menu items.
///
/// The chevron-down indicator, fixed height, and horizontal padding are owned
/// by this view to keep all composer pills visually consistent. Callers supply
/// only the leading icon + text via the ``label`` builder.
@MainActor
struct ComposerPillMenu<Label: View, Menu: View>: View {
    /// When `false` the trigger is rendered as a disabled button and the menu
    /// cannot be opened. Mirrors SwiftUI's `.disabled(_:)` semantics.
    var isEnabled: Bool = true

    /// VoiceOver label announced for the trigger.
    let accessibilityLabel: String

    /// VoiceOver value announced alongside the label (typically the current
    /// selection's display string).
    let accessibilityValue: String

    /// Tooltip shown on hover.
    let tooltip: String

    /// Width of the popover menu surface.
    var menuWidth: CGFloat = 240

    /// Leading content of the pill — typically an icon followed by a label
    /// `Text`. The chevron is appended by this view.
    @ViewBuilder let label: () -> Label

    /// Body of the popover menu — typically a ``VMenu`` with ``VMenuItem``
    /// rows. Wrapped in a ``VMenu`` of width ``menuWidth`` by this view.
    @ViewBuilder let menu: () -> Menu

    #if os(macOS)
    @State private var isMenuOpen = false
    @State private var activePanel: VMenuPanel?
    @State private var triggerFrame: CGRect = .zero
    #endif

    private let composerActionButtonSize: CGFloat = 32

    var body: some View {
        #if os(macOS)
        Button {
            if isMenuOpen {
                activePanel?.close()
                activePanel = nil
                isMenuOpen = false
            } else {
                showMenu()
            }
        } label: {
            HStack(spacing: 4) {
                label()
                VIconView(.chevronDown, size: 10)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .frame(height: composerActionButtonSize)
            .padding(.horizontal, VSpacing.xs)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .vTooltip(tooltip)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityValue(accessibilityValue)
        .overlay {
            GeometryReader { geo in
                Color.clear
                    .onAppear { triggerFrame = geo.frame(in: .global) }
                    .onChange(of: geo.frame(in: .global)) { _, newFrame in
                        triggerFrame = newFrame
                    }
            }
        }
        #endif
    }

    // MARK: - Menu

    #if os(macOS)
    private func showMenu() {
        guard !isMenuOpen, isEnabled else { return }
        isMenuOpen = true

        NSApp.keyWindow?.makeFirstResponder(nil)

        guard let window = NSApp.keyWindow ?? NSApp.windows.first(where: { $0.isVisible }) else {
            isMenuOpen = false
            return
        }

        let triggerInWindow = CGPoint(x: triggerFrame.minX, y: triggerFrame.maxY)
        let screenPoint = window.convertPoint(toScreen: NSPoint(
            x: triggerInWindow.x,
            y: window.frame.height - triggerInWindow.y
        ))

        let triggerScreenOrigin = window.convertPoint(toScreen: NSPoint(
            x: triggerFrame.minX,
            y: window.frame.height - triggerFrame.maxY
        ))
        let triggerScreenRect = CGRect(
            origin: triggerScreenOrigin,
            size: CGSize(width: triggerFrame.width, height: triggerFrame.height)
        )

        let appearance = window.effectiveAppearance
        activePanel = VMenuPanel.show(
            at: screenPoint,
            sourceWindow: window,
            sourceAppearance: appearance,
            excludeRect: triggerScreenRect
        ) {
            VMenu(width: menuWidth) {
                menu()
            }
        } onDismiss: {
            isMenuOpen = false
            activePanel = nil
        }
    }
    #endif
}
