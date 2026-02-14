import SwiftUI

/// Shared pixel-step border used by retro chips and badges across surfaces.
struct PixelBorderShape: Shape {
    let pixelSize: CGFloat
    let cornerSteps: Int

    init(pixelSize: CGFloat = 3, cornerSteps: Int = 3) {
        self.pixelSize = pixelSize
        self.cornerSteps = cornerSteps
    }

    func path(in rect: CGRect) -> Path {
        let step = pixelSize
        let corners = cornerSteps
        let width = rect.width
        let height = rect.height

        var path = Path()

        path.move(to: CGPoint(x: CGFloat(corners) * step, y: 0))
        path.addLine(to: CGPoint(x: width - CGFloat(corners) * step, y: 0))

        for index in 0..<corners {
            let i = CGFloat(index)
            path.addLine(to: CGPoint(x: width - CGFloat(corners - 1 - index) * step, y: i * step))
            path.addLine(to: CGPoint(x: width - CGFloat(corners - 1 - index) * step, y: (i + 1) * step))
        }

        path.addLine(to: CGPoint(x: width, y: height - CGFloat(corners) * step))

        for index in 0..<corners {
            let i = CGFloat(index)
            path.addLine(to: CGPoint(x: width - i * step, y: height - CGFloat(corners - 1 - index) * step))
            path.addLine(to: CGPoint(x: width - (i + 1) * step, y: height - CGFloat(corners - 1 - index) * step))
        }

        path.addLine(to: CGPoint(x: CGFloat(corners) * step, y: height))

        for index in 0..<corners {
            let i = CGFloat(index)
            path.addLine(to: CGPoint(x: CGFloat(corners - 1 - index) * step, y: height - i * step))
            path.addLine(to: CGPoint(x: CGFloat(corners - 1 - index) * step, y: height - (i + 1) * step))
        }

        path.addLine(to: CGPoint(x: 0, y: CGFloat(corners) * step))

        for index in 0..<corners {
            let i = CGFloat(index)
            path.addLine(to: CGPoint(x: i * step, y: CGFloat(corners - 1 - index) * step))
            path.addLine(to: CGPoint(x: (i + 1) * step, y: CGFloat(corners - 1 - index) * step))
        }

        path.closeSubpath()
        return path
    }
}
