import SwiftUI
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

/// A copy-to-clipboard button with checkmark feedback.
///
/// Copies the provided string to the system pasteboard when tapped. Shows
/// a checkmark icon for 1.5 seconds after copying, then reverts to the
/// copy icon. Supports icon-only (default) and icon+label modes.
///
/// ```swift
/// // Icon-only (compact)
/// VCopyButton(text: url)
///
/// // Icon + label
/// VCopyButton(text: code, style: .labeled)
///
/// // Custom size and tooltip
/// VCopyButton(text: json, iconSize: 14, accessibilityHint: "Copy JSON")
/// ```
public struct VCopyButton: View {
    /// Visual style of the button.
    public enum Style {
        /// Icon only — shows just the copy/check icon.
        case iconOnly
        /// Icon + text label — shows "Copy" / "Copied" next to the icon.
        case labeled
    }

    /// The string to copy to the pasteboard.
    public let text: String

    /// Visual style. Defaults to `.iconOnly`.
    public var style: Style = .iconOnly

    /// Icon size in points. Defaults to 11.
    public var iconSize: CGFloat = 11

    /// Tooltip text shown on hover. Defaults to "Copy" / "Copied!".
    public var accessibilityHint: String?

    @State private var copied = false
    @State private var isHovered = false
    @State private var resetTask: Task<Void, Never>?

    public init(
        text: String,
        style: Style = .iconOnly,
        iconSize: CGFloat = 11,
        accessibilityHint: String? = nil
    ) {
        self.text = text
        self.style = style
        self.iconSize = iconSize
        self.accessibilityHint = accessibilityHint
    }

    public var body: some View {
        Button(action: copyToClipboard) {
            HStack(spacing: VSpacing.xxs) {
                VIconView(copied ? .check : .copy, size: iconSize)
                if style == .labeled {
                    Text(copied ? "Copied" : "Copy")
                        .font(VFont.caption)
                }
            }
            .foregroundColor(foregroundColor)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .animation(VAnimation.fast, value: copied)
        .accessibilityLabel(copied ? "Copied" : (accessibilityHint ?? "Copy"))
        .help(copied ? "Copied!" : (accessibilityHint ?? "Copy"))
        .pointerCursor(onHover: { hovering in
            isHovered = hovering
        })
        .onDisappear {
            resetTask?.cancel()
        }
    }

    // MARK: - Private

    private var foregroundColor: Color {
        if copied {
            return VColor.systemPositiveStrong
        }
        return isHovered ? VColor.contentDefault : VColor.contentSecondary
    }

    private func copyToClipboard() {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #elseif os(iOS)
        UIPasteboard.general.string = text
        #endif

        copied = true
        resetTask?.cancel()
        resetTask = Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard !Task.isCancelled else { return }
            copied = false
        }
    }
}
