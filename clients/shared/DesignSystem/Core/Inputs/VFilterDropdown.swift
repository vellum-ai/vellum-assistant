#if os(macOS)
import SwiftUI
import AppKit

/// Reusable filter dropdown that shows a VMenu via VMenuPanel.
///
/// Renders a trigger button with label + chevron using `.vInputChrome(isFocused:)`
/// and shows a VMenu below the trigger on click. The trigger shows a focus-style
/// border while the menu is open.
///
/// Usage:
/// ```swift
/// VFilterDropdown(
///     options: [
///         VFilterOption(label: "All", value: .all, icon: .circle),
///         VFilterOption(label: "Installed", value: .installed, icon: .circleCheck),
///     ],
///     selection: $filter
/// )
/// ```
public struct VFilterOption<T: Hashable>: Identifiable {
    public let label: String
    public let value: T
    public let icon: VIcon?

    public var id: String { label }

    public init(label: String, value: T, icon: VIcon? = nil) {
        self.label = label
        self.value = value
        self.icon = icon
    }
}

public struct VFilterDropdown<T: Hashable>: View {
    public let options: [VFilterOption<T>]
    @Binding public var selection: T
    public var width: CGFloat = 150
    public var menuWidth: CGFloat = 180
    public var onChange: ((T) -> Void)?

    @State private var isOpen = false
    @State private var activePanel: VMenuPanel?

    public init(
        options: [VFilterOption<T>],
        selection: Binding<T>,
        width: CGFloat = 150,
        menuWidth: CGFloat = 180,
        onChange: ((T) -> Void)? = nil
    ) {
        self.options = options
        self._selection = selection
        self.width = width
        self.menuWidth = menuWidth
        self.onChange = onChange
    }

    private var selectedLabel: String {
        options.first { $0.value == selection }?.label ?? ""
    }

    public var body: some View {
        Button {
            if isOpen {
                activePanel?.close()
                activePanel = nil
                isOpen = false
            } else {
                showMenu()
            }
        } label: {
            HStack(spacing: VSpacing.md) {
                Text(selectedLabel)
                    .foregroundStyle(VColor.contentDefault)
                    .font(VFont.bodyMediumLighter)
                    .frame(maxWidth: .infinity, alignment: .leading)

                VIconView(.chevronDown, size: 13)
                    .foregroundStyle(VColor.contentTertiary)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, VSpacing.sm)
            .frame(height: 32)
            .vInputChrome(isFocused: isOpen)
        }
        .buttonStyle(.plain)
        .frame(width: width)
        .accessibilityLabel("Filter: \(selectedLabel)")
        .overlay {
            GeometryReader { geo in
                Color.clear
                    .onAppear { triggerFrame = geo.frame(in: .global) }
                    .onChange(of: geo.frame(in: .global)) { _, newFrame in
                        triggerFrame = newFrame
                    }
            }
        }
    }

    @State private var triggerFrame: CGRect = .zero

    private func showMenu() {
        guard !isOpen else { return }
        isOpen = true

        // Resign first responder so text inputs lose focus
        NSApp.keyWindow?.makeFirstResponder(nil)

        guard let window = NSApp.keyWindow ?? NSApp.windows.first(where: { $0.isVisible }) else {
            isOpen = false
            return
        }

        // Convert trigger frame to screen coordinates — position menu at bottom-left of trigger
        let triggerInWindow = CGPoint(
            x: triggerFrame.minX,
            y: triggerFrame.maxY
        )
        let screenPoint = window.convertPoint(toScreen: NSPoint(
            x: triggerInWindow.x,
            y: window.frame.height - triggerInWindow.y
        ))

        let appearance = window.effectiveAppearance
        activePanel = VMenuPanel.show(at: screenPoint, sourceAppearance: appearance) {
            VMenu(width: menuWidth) {
                ForEach(options) { option in
                    VMenuItem(
                        icon: option.icon?.rawValue,
                        label: option.label,
                        isActive: selection == option.value,
                        size: .regular
                    ) {
                        withAnimation(VAnimation.fast) { selection = option.value }
                        onChange?(option.value)
                    } trailing: {
                        if selection == option.value {
                            VIconView(.check, size: 12)
                                .foregroundStyle(VColor.primaryBase)
                        }
                    }
                }
            }
        } onDismiss: {
            isOpen = false
            activePanel = nil
        }
    }
}
#endif
