import AppKit
import SwiftUI
import VellumAssistantShared

/// A zoomable, pannable image view for the lightbox overlay.
///
/// Supports scroll-to-zoom (1x–8x), double-click to toggle fit/actual size,
/// and drag-to-pan when zoomed beyond fit. Uses a local NSEvent scroll-wheel
/// monitor for smooth zoom tracking.
struct ZoomableImageView: View {
    let image: NSImage
    @Environment(\.displayScale) private var displayScale

    @State private var scale: CGFloat = 1.0
    @State private var offset: CGSize = .zero
    @State private var isDragging = false
    @State private var scrollMonitor: Any?

    /// The geometry size of the container, captured for offset clamping.
    @State private var containerSize: CGSize = .zero

    private let minScale: CGFloat = 1.0
    private let maxScale: CGFloat = 8.0

    var body: some View {
        GeometryReader { geometry in
            let fittedSize = fittedImageSize(in: geometry.size)

            ZStack {
                // Transparent hit target for the full container
                Color.clear

                imageLayer(fittedSize: fittedSize)
                    .scaleEffect(scale)
                    .offset(x: offset.width, y: offset.height)
                    .gesture(dragGesture(fittedSize: fittedSize, containerSize: geometry.size))
                    .onTapGesture(count: 2) {
                        handleDoubleClick(fittedSize: fittedSize, containerSize: geometry.size)
                    }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .onAppear {
                containerSize = geometry.size
                installScrollMonitor()
            }
            .onDisappear {
                removeScrollMonitor()
            }
            .onChange(of: geometry.size) { _, newSize in
                containerSize = newSize
                // Reset zoom when container resizes (e.g. window resize)
                withAnimation(VAnimation.fast) {
                    scale = 1.0
                    offset = .zero
                }
            }
        }
    }

    // MARK: - Image Layer

    @ViewBuilder
    private func imageLayer(fittedSize: CGSize) -> some View {
        if let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) {
            Image(decorative: cgImage, scale: displayScale)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                .frame(width: fittedSize.width, height: fittedSize.height)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .shadow(color: VColor.auxBlack.opacity(0.4), radius: 24, y: 8)
        } else {
            Image(nsImage: image)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: fittedSize.width, height: fittedSize.height)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .shadow(color: VColor.auxBlack.opacity(0.4), radius: 24, y: 8)
        }
    }

    // MARK: - Sizing

    /// Computes the image size when fitted (aspect-fit) within the container with padding.
    private func fittedImageSize(in containerSize: CGSize) -> CGSize {
        let padding: CGFloat = VSpacing.xxxl * 2
        let availableWidth = max(containerSize.width - padding, 1)
        let availableHeight = max(containerSize.height - padding, 1)

        guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
            return CGSize(width: availableWidth, height: availableHeight)
        }

        let imageWidth = CGFloat(cgImage.width) / displayScale
        let imageHeight = CGFloat(cgImage.height) / displayScale

        let widthRatio = availableWidth / imageWidth
        let heightRatio = availableHeight / imageHeight
        let fitScale = min(widthRatio, heightRatio, 1.0) // Don't upscale

        return CGSize(
            width: imageWidth * fitScale,
            height: imageHeight * fitScale
        )
    }

    // MARK: - Double Click

    private func handleDoubleClick(fittedSize: CGSize, containerSize: CGSize) {
        withAnimation(VAnimation.panel) {
            if scale > 1.01 {
                // Zoomed in — reset to fit
                scale = 1.0
                offset = .zero
            } else {
                // At fit — zoom to actual pixel size (or 2x if already at actual)
                guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return }
                let nativeWidth = CGFloat(cgImage.width) / displayScale
                let actualScale = nativeWidth / fittedSize.width
                scale = min(max(actualScale, 2.0), maxScale)
            }
        }
    }

    // MARK: - Drag Gesture

    private func dragGesture(fittedSize: CGSize, containerSize: CGSize) -> some Gesture {
        DragGesture()
            .onChanged { value in
                guard scale > 1.01 else { return }
                if !isDragging {
                    isDragging = true
                    NSCursor.closedHand.push()
                }
                offset = clampedOffset(
                    CGSize(width: offset.width + value.translation.width,
                           height: offset.height + value.translation.height),
                    fittedSize: fittedSize,
                    containerSize: containerSize
                )
            }
            .onEnded { value in
                if isDragging {
                    isDragging = false
                    NSCursor.pop()
                }
                offset = clampedOffset(
                    CGSize(width: offset.width + value.translation.width,
                           height: offset.height + value.translation.height),
                    fittedSize: fittedSize,
                    containerSize: containerSize
                )
            }
    }

    // MARK: - Scroll Wheel Zoom

    private func installScrollMonitor() {
        scrollMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { event in
            // Only handle scroll-wheel zoom when the lightbox is showing
            // Use pinch (trackpad) or scroll (mouse) delta for zoom
            let delta: CGFloat
            if event.hasPreciseScrollingDeltas {
                // Trackpad pinch — use vertical delta
                delta = event.scrollingDeltaY / 100
            } else {
                // Mouse scroll wheel
                delta = event.scrollingDeltaY / 10
            }

            guard abs(delta) > 0.001 else { return event }

            let newScale = max(minScale, min(maxScale, scale * (1 + delta)))

            withAnimation(VAnimation.snappy) {
                scale = newScale
                if newScale <= 1.01 {
                    offset = .zero
                } else {
                    let fittedSize = fittedImageSize(in: containerSize)
                    offset = clampedOffset(offset, fittedSize: fittedSize, containerSize: containerSize)
                }
            }

            return event
        }
    }

    private func removeScrollMonitor() {
        if let monitor = scrollMonitor {
            NSEvent.removeMonitor(monitor)
            scrollMonitor = nil
        }
    }

    // MARK: - Offset Clamping

    /// Clamps the pan offset so the image can't be dragged entirely off-screen.
    /// Allows up to half the scaled image to extend beyond the container edge.
    private func clampedOffset(_ proposed: CGSize, fittedSize: CGSize, containerSize: CGSize) -> CGSize {
        let scaledWidth = fittedSize.width * scale
        let scaledHeight = fittedSize.height * scale

        let maxOffsetX = max((scaledWidth - containerSize.width) / 2, 0)
        let maxOffsetY = max((scaledHeight - containerSize.height) / 2, 0)

        return CGSize(
            width: max(-maxOffsetX, min(maxOffsetX, proposed.width)),
            height: max(-maxOffsetY, min(maxOffsetY, proposed.height))
        )
    }
}
