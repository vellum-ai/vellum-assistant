import SwiftUI
import VellumAssistantShared

/// Full-window image lightbox overlay with warm cinema aesthetic.
///
/// Renders a semi-transparent dark backdrop with the image centered and zoomable.
/// Includes a floating frosted-glass toolbar at the bottom with file info and actions,
/// and a close button in the top-right corner.
struct ImageLightboxOverlay: View {
    @ObservedObject var windowState: MainWindowState
    @FocusState private var isFocused: Bool

    private var lightbox: ImageLightboxState? { windowState.imageLightbox }

    var body: some View {
        if let lightbox {
            ZStack {
                // Warm dark backdrop
                VColor.auxBlack.opacity(0.85)
                    .ignoresSafeArea()
                    .onTapGesture { dismiss() }

                // Zoomable image
                ZoomableImageView(image: lightbox.displayImage)
                    .padding(VSpacing.xxl)

                // Loading spinner for lazy-load
                if lightbox.isLoadingFullRes {
                    ProgressView()
                        .scaleEffect(1.5)
                        .tint(VColor.auxWhite)
                }

                // Close button (top-right)
                closeButton
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                    .padding(VSpacing.lg)

                // Floating toolbar (bottom)
                lightboxToolbar(lightbox)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                    .padding(.bottom, VSpacing.xl)
            }
            .environment(\.colorScheme, .dark)
            .focusable()
            .focused($isFocused)
            .onKeyPress(.escape) {
                dismiss()
                return .handled
            }
            .onAppear { isFocused = true }
            .transition(.opacity.animation(VAnimation.standard))
        }
    }

    // MARK: - Close Button

    private var closeButton: some View {
        VButton(
            label: "Close",
            iconOnly: VIcon.x.rawValue,
            style: .outlined,
            action: dismiss
        )
    }

    // MARK: - Toolbar

    private func lightboxToolbar(_ lightbox: ImageLightboxState) -> some View {
        HStack(spacing: VSpacing.md) {
            // Filename
            Text(lightbox.filename)
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.auxWhite.opacity(0.7))
                .lineLimit(1)
                .truncationMode(.middle)

            Divider()
                .frame(height: 16)
                .background(VColor.auxWhite.opacity(0.2))

            // Copy
            VButton(label: "Copy", icon: VIcon.copy.rawValue, style: .ghost, size: .compact) {
                let image = lightbox.displayImage
                if let base64 = lightbox.base64Data {
                    ImageActions.copyToClipboard(image, base64Data: base64)
                } else {
                    ImageActions.copyToClipboard(image)
                }
                AppDelegate.shared?.mainWindow?.windowState.showToast(
                    message: "Copied to clipboard",
                    style: .success
                )
            }

            // Save As
            VButton(label: "Save", icon: VIcon.arrowDownToLine.rawValue, style: .ghost, size: .compact) {
                let image = lightbox.displayImage
                ImageActions.saveImageAs(
                    image,
                    filename: lightbox.filename,
                    base64Data: lightbox.base64Data
                )
            }

            // Open in Preview
            VButton(label: "Preview", icon: VIcon.eye.rawValue, style: .ghost, size: .compact) {
                let image = lightbox.displayImage
                ImageActions.openInPreview(
                    image,
                    filename: lightbox.filename,
                    base64Data: lightbox.base64Data
                )
            }
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .background(
            Capsule()
                .fill(.ultraThinMaterial)
                .shadow(color: VColor.auxBlack.opacity(0.3), radius: 12, y: 4)
        )
    }

    // MARK: - Actions

    private func dismiss() {
        withAnimation(VAnimation.standard) {
            windowState.dismissImageLightbox()
        }
    }

}
