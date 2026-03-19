import SwiftUI
#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

/// A copy-to-clipboard button built on `VButton` (ghost style) with
/// checkmark feedback.
///
/// Copies the provided string to the system pasteboard when tapped. Shows
/// a checkmark icon for 1.5 seconds after copying, then reverts to the
/// copy icon. Accepts `VButton.Size` variants for different contexts.
///
/// ```swift
/// // Icon-only (default, regular size)
/// VCopyButton(text: url)
///
/// // Compact size for toolbars
/// VCopyButton(text: json, size: .compact)
///
/// // Custom frame size and tooltip
/// VCopyButton(text: json, iconSize: 28, accessibilityHint: "Copy JSON")
/// ```
public struct VCopyButton: View {
    /// The string to copy to the pasteboard.
    public let text: String

    /// Button size variant. Defaults to `.regular`.
    public var size: VButton.Size

    /// Frame size in points passed to VButton's `iconSize`.
    /// When `nil`, VButton uses its default (32pt).
    public var iconSize: CGFloat?

    /// Tooltip text shown on hover. Defaults to "Copy" / "Copied!".
    public var accessibilityHint: String?

    @State private var copied = false
    @State private var resetTask: Task<Void, Never>?

    public init(
        text: String,
        size: VButton.Size = .regular,
        iconSize: CGFloat? = nil,
        accessibilityHint: String? = nil
    ) {
        self.text = text
        self.size = size
        self.iconSize = iconSize
        self.accessibilityHint = accessibilityHint
    }

    public var body: some View {
        VButton(
            label: copied ? "Copied" : (accessibilityHint ?? "Copy"),
            iconOnly: (copied ? VIcon.check : VIcon.copy).rawValue,
            style: .ghost,
            size: size,
            iconSize: iconSize,
            tooltip: copied ? "Copied!" : (accessibilityHint ?? "Copy"),
            iconColor: copied ? VColor.systemPositiveStrong : nil,
            action: copyToClipboard
        )
        .animation(VAnimation.fast, value: copied)
        .onDisappear {
            resetTask?.cancel()
        }
    }

    // MARK: - Private

    private func copyToClipboard() {
        Self.copyToPasteboard(text)

        copied = true
        resetTask?.cancel()
        resetTask = Task {
            try? await Task.sleep(for: .seconds(1.5))
            guard !Task.isCancelled else { return }
            copied = false
        }
    }

    /// Copies a string to the system pasteboard. Shared utility so callers
    /// outside `VCopyButton` (e.g. context menus) don't duplicate the
    /// platform-conditional pasteboard logic.
    public static func copyToPasteboard(_ text: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #elseif os(iOS)
        UIPasteboard.general.string = text
        #endif
    }
}
