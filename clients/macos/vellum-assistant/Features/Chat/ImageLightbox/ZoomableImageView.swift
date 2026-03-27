import AppKit
import SwiftUI
import VellumAssistantShared

/// A zoomable, pannable image view for the lightbox overlay.
///
/// Supports pinch-to-zoom (trackpad), scroll-to-zoom (mouse wheel),
/// double-click to toggle fit/actual size, and drag-to-pan when zoomed.
struct ZoomableImageView: View {
    let image: NSImage
    @Environment(\.displayScale) private var displayScale

    @State private var scale: CGFloat = 1.0
    @State private var offset: CGSize = .zero
    @State private var isDragging = false
    @State private var scrollMonitor: Any?
    @State private var magnifyMonitor: Any?

    /// Tracks the scale at the start of a pinch gesture so incremental
    /// magnification deltas compound correctly.
    @State private var pinchBaseScale: CGFloat = 1.0

    /// The geometry size of the container, captured for offset clamping.
    @State private var containerSize: CGSize = .zero

    private let minScale: CGFloat = 0.5
    private let maxScale: CGFloat = 10.0

    var body: some View {
        GeometryReader { geometry in
            let fittedSize = fittedImageSize(in: geometry.size)

            ZStack {
                Color.clear

                imageLayer(fittedSize: fittedSize)
                    .scaleEffect(scale)
                    .offset(x: offset.width, y: offset.height)
                    .gesture(dragGesture(fittedSize: fittedSize, containerSize: geometry.size))
                    .gesture(magnifyGesture(fittedSize: fittedSize, containerSize: geometry.size))
                    .onTapGesture(count: 2) {
                        handleDoubleClick(fittedSize: fittedSize, containerSize: geometry.size)
                    }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .onAppear {
                containerSize = geometry.size
                installEventMonitors()
            }
            .onDisappear {
                removeEventMonitors()
            }
            .onChange(of: geometry.size) { _, newSize in
                containerSize = newSize
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
        let fitScale = min(widthRatio, heightRatio, 1.0)

        return CGSize(
            width: imageWidth * fitScale,
            height: imageHeight * fitScale
        )
    }

    // MARK: - Double Click

    private func handleDoubleClick(fittedSize: CGSize, containerSize: CGSize) {
        withAnimation(VAnimation.panel) {
            if scale > 1.01 {
                scale = 1.0
                offset = .zero
            } else {
                guard let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return }
                let nativeWidth = CGFloat(cgImage.width) / displayScale
                let actualScale = nativeWidth / fittedSize.width
                scale = min(max(actualScale, 2.0), maxScale)
            }
        }
    }

    // MARK: - Pinch-to-Zoom Gesture (Trackpad)

    private func magnifyGesture(fittedSize: CGSize, containerSize: CGSize) -> some Gesture {
        MagnifyGesture()
            .onChanged { value in
                let proposed = pinchBaseScale * value.magnification
                withAnimation(VAnimation.snappy) {
                    scale = max(minScale, min(maxScale, proposed))
                    if scale <= 1.01 {
                        offset = .zero
                    } else {
                        offset = clampedOffset(offset, fittedSize: fittedSize, containerSize: containerSize)
                    }
                }
            }
            .onEnded { value in
                pinchBaseScale = scale
                // Snap back to 1.0 if close
                if scale < 1.0 && scale > 0.9 {
                    withAnimation(VAnimation.panel) {
                        scale = 1.0
                        offset = .zero
                    }
                    pinchBaseScale = 1.0
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
            .onEnded { _ in
                if isDragging {
                    isDragging = false
                    NSCursor.pop()
                }
            }
    }

    // MARK: - Event Monitors

    private func installEventMonitors() {
        // Scroll wheel zoom (mouse wheel)
        scrollMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { event in
            // Only zoom with non-precise (mouse wheel) scrolling.
            // Precise scrolling (trackpad two-finger) is handled by MagnifyGesture.
            guard !event.hasPreciseScrollingDeltas else { return event }

            let delta = event.scrollingDeltaY / 10
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
            pinchBaseScale = newScale

            // Consume the event so the chat behind doesn't scroll
            return nil
        }

        // Trackpad pinch-to-zoom via NSEvent (supplements SwiftUI MagnifyGesture
        // which can be unreliable when competing with other gestures)
        magnifyMonitor = NSEvent.addLocalMonitorForEvents(matching: .magnify) { event in
            let newScale = max(minScale, min(maxScale, scale * (1 + event.magnification)))
            withAnimation(VAnimation.snappy) {
                scale = newScale
                if newScale <= 1.01 {
                    offset = .zero
                } else {
                    let fittedSize = fittedImageSize(in: containerSize)
                    offset = clampedOffset(offset, fittedSize: fittedSize, containerSize: containerSize)
                }
            }
            pinchBaseScale = newScale

            return nil
        }
    }

    private func removeEventMonitors() {
        if let monitor = scrollMonitor {
            NSEvent.removeMonitor(monitor)
            scrollMonitor = nil
        }
        if let monitor = magnifyMonitor {
            NSEvent.removeMonitor(monitor)
            magnifyMonitor = nil
        }
    }

    // MARK: - Offset Clamping

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
