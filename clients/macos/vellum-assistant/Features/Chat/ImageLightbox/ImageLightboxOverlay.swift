import AppKit
import SwiftUI
import VellumAssistantShared

/// Full-window image lightbox overlay with warm cinema aesthetic.
///
/// Renders a semi-transparent dark backdrop with the image centered and zoomable.
/// Includes a floating frosted-glass toolbar at the bottom with file info and actions,
/// and a close button in the top-right corner.
struct ImageLightboxOverlay: View {
    @ObservedObject var windowState: MainWindowState
    @State private var showControls = true
    @State private var controlsHideTask: Task<Void, Never>?

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
                VStack {
                    HStack {
                        Spacer()
                        closeButton
                    }
                    Spacer()
                }
                .padding(VSpacing.lg)

                // Floating toolbar (bottom)
                VStack {
                    Spacer()
                    toolbar(lightbox)
                }
                .padding(.bottom, VSpacing.xl)
            }
            .onExitCommand { dismiss() }
            .transition(.opacity.animation(VAnimation.standard))
        }
    }

    // MARK: - Close Button

    private var closeButton: some View {
        Button { dismiss() } label: {
            ZStack {
                Circle()
                    .fill(.ultraThinMaterial)
                    .frame(width: 32, height: 32)

                VIconView(.x, size: 14)
                    .foregroundStyle(VColor.auxWhite.opacity(0.8))
            }
        }
        .buttonStyle(.plain)
        .shadow(color: VColor.auxBlack.opacity(0.3), radius: 8)
    }

    // MARK: - Toolbar

    @available(macOS, deprecated: 13.0)
    private func toolbar(_ lightbox: ImageLightboxState) -> some View {
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
            toolbarButton(icon: .copy, label: "Copy") {
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
            toolbarButton(icon: .arrowDownToLine, label: "Save") {
                let image = lightbox.displayImage
                ImageActions.saveImageAs(
                    image,
                    filename: lightbox.filename,
                    base64Data: lightbox.base64Data
                )
            }

            // Open in Preview (fallback)
            toolbarButton(icon: .eye, label: "Preview") {
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

    private func toolbarButton(icon: VIcon, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: VSpacing.xs) {
                VIconView(icon, size: 13)
                Text(label)
                    .font(VFont.labelDefault)
            }
            .foregroundStyle(VColor.auxWhite.opacity(0.8))
            .padding(.horizontal, VSpacing.xs)
            .padding(.vertical, VSpacing.xxs)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerCursor()
    }

    // MARK: - Actions

    private func dismiss() {
        withAnimation(VAnimation.standard) {
            windowState.dismissImageLightbox()
        }
    }
}
