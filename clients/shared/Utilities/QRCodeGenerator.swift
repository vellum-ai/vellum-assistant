#if os(macOS)
import CoreImage
import AppKit

/// Generates QR code images from string data using CoreImage.
public enum QRCodeGenerator {
    /// Generate a QR code NSImage from a string payload.
    /// - Parameters:
    ///   - string: The data to encode in the QR code.
    ///   - size: The desired output size in points (QR codes are square).
    /// - Returns: An NSImage of the QR code, or nil if generation fails.
    public static func generate(from string: String, size: CGFloat = 200) -> NSImage? {
        guard let data = string.data(using: .utf8),
              let filter = CIFilter(name: "CIQRCodeGenerator") else {
            return nil
        }

        filter.setValue(data, forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")

        guard let ciImage = filter.outputImage else { return nil }

        // Scale the tiny CIFilter output to the desired size
        let scaleX = size / ciImage.extent.size.width
        let scaleY = size / ciImage.extent.size.height
        let scaled = ciImage.transformed(by: CGAffineTransform(scaleX: scaleX, y: scaleY))

        let rep = NSCIImageRep(ciImage: scaled)
        let nsImage = NSImage(size: rep.size)
        nsImage.addRepresentation(rep)
        return nsImage
    }
}
#endif
