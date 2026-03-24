import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Standardized modal container providing consistent chrome: title, optional
/// subtitle, scrollable content area, and an optional footer.
///
/// Supports optional navigation actions:
/// - `closeAction`: Shows an X button in the header's trailing position.
/// - `backAction`: Shows a "Back" button in the header's leading position,
///   replacing the title. Use this for multi-screen modals where a sub-screen
///   needs to navigate back to the root (e.g. `AvatarManagementSheet`).
///
/// The modal caps its height at a percentage of the screen height (default
/// 80%) so content scrolls rather than pushing the modal off-screen.
public struct VModal<Content: View, Footer: View>: View {
    public let title: String
    public let subtitle: String?
    public let maxHeightRatio: CGFloat
    public let closeAction: (() -> Void)?
    public let backAction: (() -> Void)?
    @ViewBuilder public let content: () -> Content
    @ViewBuilder public let footer: () -> Footer

    public init(
        title: String,
        subtitle: String? = nil,
        maxHeightRatio: CGFloat = 0.8,
        closeAction: (() -> Void)? = nil,
        backAction: (() -> Void)? = nil,
        @ViewBuilder content: @escaping () -> Content,
        @ViewBuilder footer: @escaping () -> Footer
    ) {
        self.title = title
        self.subtitle = subtitle
        self.maxHeightRatio = maxHeightRatio
        self.closeAction = closeAction
        self.backAction = backAction
        self.content = content
        self.footer = footer
    }

    private var screenMaxHeight: CGFloat {
        #if os(macOS)
        let screenHeight = NSScreen.main?.visibleFrame.height ?? 800
        #else
        let screenHeight = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first?
            .screen.bounds.height ?? 800
        #endif
        return screenHeight * maxHeightRatio
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                if let backAction {
                    Button(action: backAction) {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.chevronLeft, size: 10)
                            Text("Back")
                                .font(VFont.bodyMediumDefault)
                        }
                        .foregroundColor(VColor.contentSecondary)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .pointerCursor()
                    .accessibilityLabel("Back")
                } else {
                    titleArea
                }

                Spacer(minLength: 0)

                if let closeAction {
                    Button(action: closeAction) {
                        VIconView(.x, size: 12)
                            .foregroundColor(VColor.contentTertiary)
                            .frame(width: 32, height: 32)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .pointerCursor()
                    .accessibilityLabel("Close")
                    .padding(.top, -VSpacing.sm)
                    .padding(.trailing, -VSpacing.sm)
                }
            }
            .padding(.horizontal, VSpacing.xl)
            .padding(.top, VSpacing.xl)
            .padding(.bottom, VSpacing.lg)

            ScrollView {
                content()
                    .padding(.horizontal, VSpacing.xl)
                    .padding(.vertical, VSpacing.xs)
                    .frame(maxWidth: .infinity, alignment: .top)
            }

            if Footer.self != EmptyView.self {
                footer()
                    .padding(.horizontal, VSpacing.xl)
                    .padding(.vertical, VSpacing.lg)
            }
        }
        .frame(maxHeight: screenMaxHeight)
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
    }

    @ViewBuilder
    private var titleArea: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            if !title.isEmpty {
                Text(title)
                    .font(VFont.titleSmall)
                    .foregroundColor(VColor.contentDefault)
            }
            if let subtitle {
                Text(subtitle)
                    .font(VFont.bodyMediumLighter)
                    .foregroundColor(VColor.contentSecondary)
            }
        }
    }
}

// Convenience: no footer.
public extension VModal where Footer == EmptyView {
    init(
        title: String,
        subtitle: String? = nil,
        maxHeightRatio: CGFloat = 0.8,
        closeAction: (() -> Void)? = nil,
        backAction: (() -> Void)? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.init(title: title, subtitle: subtitle, maxHeightRatio: maxHeightRatio, closeAction: closeAction, backAction: backAction, content: content, footer: { EmptyView() })
    }
}
