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
    @State private var escapeMonitor: Any?

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
                    lightboxToolbar(lightbox)
                }
                .padding(.bottom, VSpacing.xl)
            }
            .onAppear { installEscapeMonitor() }
            .onDisappear { removeEscapeMonitor() }
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

    // MARK: - Escape Key Monitor

    private func installEscapeMonitor() {
        escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard event.keyCode == 53 else { return event } // 53 = Escape
            dismiss()
            return nil
        }
    }

    private func removeEscapeMonitor() {
        if let monitor = escapeMonitor {
            NSEvent.removeMonitor(monitor)
            escapeMonitor = nil
        }
    }
}
