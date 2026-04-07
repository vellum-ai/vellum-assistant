import SwiftUI
#if os(macOS)
import AppKit
#endif

/// Option type for VDropdown.
public struct VDropdownOption<T: Hashable>: Identifiable {
    public let label: String
    public let value: T
    public let icon: VIcon?

    public var id: T { value }

    public init(label: String, value: T, icon: VIcon? = nil) {
        self.label = label
        self.value = value
        self.icon = icon
    }
}

/// A generic dropdown that shows a VMenu via VMenuPanel on macOS,
/// or a native Menu/Picker on iOS.
///
/// Usage:
/// ```swift
/// // With VDropdownOption array:
/// VDropdown(
///     options: [
///         VDropdownOption(label: "All", value: .all, icon: .circle),
///         VDropdownOption(label: "Installed", value: .installed, icon: .circleCheck),
///     ],
///     selection: $filter
/// )
///
/// // With tuple convenience:
/// VDropdown(
///     placeholder: "Select a model",
///     selection: $model,
///     options: models.map { ($0.name, $0.id) }
/// )
/// ```
public struct VDropdown<T: Hashable>: View {
    public let label: String?
    public let placeholder: String
    public let optionList: [VDropdownOption<T>]
    @Binding public var selection: T
    public var emptyValue: T?
    public var maxWidth: CGFloat = .infinity
    public var menuWidth: CGFloat = 180
    public var icon: VIcon?
    public var optionIcon: ((T) -> VIcon?)?
    public var onChange: ((T) -> Void)?

    @Environment(\.isEnabled) private var isEnabled

    /// Init with VDropdownOption array (preferred).
    public init(
        _ label: String? = nil,
        placeholder: String = "",
        options: [VDropdownOption<T>],
        selection: Binding<T>,
        emptyValue: T? = nil,
        maxWidth: CGFloat = .infinity,
        menuWidth: CGFloat = 180,
        icon: VIcon? = nil,
        optionIcon: ((T) -> VIcon?)? = nil,
        onChange: ((T) -> Void)? = nil
    ) {
        self.label = label
        self.placeholder = placeholder
        self.optionList = options
        self._selection = selection
        self.emptyValue = emptyValue
        self.maxWidth = maxWidth
        self.menuWidth = menuWidth
        self.icon = icon
        self.optionIcon = optionIcon
        self.onChange = onChange
    }

    /// Convenience init with tuple array (matches old VDropdown API for easy migration).
    public init(
        _ label: String? = nil,
        placeholder: String,
        selection: Binding<T>,
        options: [(label: String, value: T)],
        emptyValue: T? = nil,
        maxWidth: CGFloat = .infinity,
        menuWidth: CGFloat = 180,
        icon: VIcon? = nil,
        optionIcon: ((T) -> VIcon?)? = nil,
        onChange: ((T) -> Void)? = nil
    ) {
        self.label = label
        self.placeholder = placeholder
        self.optionList = options.map { VDropdownOption(label: $0.label, value: $0.value) }
        self._selection = selection
        self.emptyValue = emptyValue
        self.maxWidth = maxWidth
        self.menuWidth = menuWidth
        self.icon = icon
        self.optionIcon = optionIcon
        self.onChange = onChange
    }

    private var selectedLabel: String? {
        if let emptyValue, selection == emptyValue { return nil }
        return optionList.first { $0.value == selection }?.label
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            if let label {
                Text(label)
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(isEnabled ? VColor.contentSecondary : VColor.contentDisabled)
                    .accessibilityHidden(true)
            }

            #if os(macOS)
            macOSTrigger
            #else
            iOSMenu
            #endif
        }
        .frame(maxWidth: maxWidth)
    }

    // MARK: - iOS Fallback (native Menu/Picker)

    #if os(iOS)
    private var iOSMenu: some View {
        Menu {
            Picker("", selection: $selection) {
                ForEach(optionList) { option in
                    Text(option.label).tag(option.value)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        } label: {
            triggerLabel
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
    }
    #endif

    // MARK: - macOS (VMenuPanel)

    #if os(macOS)
    @State private var isOpen = false
    @State private var activePanel: VMenuPanel?
    @State private var triggerFrame: CGRect = .zero

    private var macOSTrigger: some View {
        Button {
            if isOpen {
                activePanel?.close()
                activePanel = nil
                isOpen = false
            } else {
                showMenu()
            }
        } label: {
            triggerLabel
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .accessibilityLabel(label ?? placeholder)
        .accessibilityValue(selectedLabel ?? "")
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

    private func showMenu() {
        guard !isOpen else { return }
        isOpen = true

        NSApp.keyWindow?.makeFirstResponder(nil)

        guard let window = NSApp.keyWindow ?? NSApp.windows.first(where: { $0.isVisible }) else {
            isOpen = false
            return
        }

        let triggerInWindow = CGPoint(x: triggerFrame.minX, y: triggerFrame.maxY)
        let screenPoint = window.convertPoint(toScreen: NSPoint(
            x: triggerInWindow.x,
            y: window.frame.height - triggerInWindow.y
        ))

        // Compute trigger rect in screen coordinates so VMenuPanel's click-outside
        // handler can ignore clicks on the trigger (letting the button toggle close).
        let triggerScreenOrigin = window.convertPoint(toScreen: NSPoint(
            x: triggerFrame.minX,
            y: window.frame.height - triggerFrame.maxY
        ))
        let triggerScreenRect = CGRect(
            origin: triggerScreenOrigin,
            size: CGSize(width: triggerFrame.width, height: triggerFrame.height)
        )

        let appearance = window.effectiveAppearance
        // Pass the resolved source window explicitly so VMenuPanel attaches the
        // popup as a child of the trigger's window. Without this, VMenuPanel
        // would fall back to a geometric search and could pick up the wrong
        // window when the trigger lives in a modal that overlaps a larger
        // window behind it (e.g. the Share Feedback modal over the main app
        // window) — attaching to the wrong parent shoves the modal behind via
        // `addChildWindow`.
        activePanel = VMenuPanel.show(at: screenPoint, sourceWindow: window, sourceAppearance: appearance, excludeRect: triggerScreenRect) {
            VMenu(width: menuWidth) {
                ForEach(optionList) { option in
                    VMenuItem(
                        icon: option.icon?.rawValue ?? optionIcon?(option.value)?.rawValue,
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
    #endif

    // MARK: - Shared Trigger Label

    private var triggerLabel: some View {
        HStack(spacing: VSpacing.sm) {
            if let resolvedIcon = icon ?? optionIcon?(selection) {
                VIconView(resolvedIcon, size: 14)
                    .foregroundStyle(VColor.contentTertiary)
            }

            Group {
                if let selectedLabel {
                    Text(selectedLabel)
                        .foregroundStyle(isEnabled ? VColor.contentDefault : VColor.contentDisabled)
                } else {
                    Text(placeholder)
                        .foregroundStyle(VColor.contentTertiary)
                }
            }
            .font(VFont.bodyMediumLighter)
            .frame(maxWidth: .infinity, alignment: .leading)

            VIconView(.chevronDown, size: 13)
                .foregroundStyle(VColor.contentTertiary)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, VSpacing.sm)
        .frame(height: 32)
        .frame(maxWidth: .infinity)
        #if os(macOS)
        .vInputChrome(isFocused: isOpen, isDisabled: !isEnabled)
        #else
        .vInputChrome(isDisabled: !isEnabled)
        #endif
    }
}
