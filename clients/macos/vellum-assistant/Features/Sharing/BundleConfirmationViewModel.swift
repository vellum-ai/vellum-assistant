import AppKit
import Foundation
import SwiftUI
import VellumAssistantShared

@MainActor
@Observable
final class BundleConfirmationViewModel {
    let manifest: IPCOpenBundleResponseManifest
    let scanResult: IPCOpenBundleResponseScanResult
    let signatureResult: IPCOpenBundleResponseSignatureResult
    let bundleSizeBytes: Int
    let filePath: String

    var onConfirm: (() -> Void)?
    var onCancel: (() -> Void)?

    var showTamperedWarning = false
    var warningsExpanded = false

    /// The app icon extracted from the .vellum ZIP, or a fallback emoji rendering.
    var appIconImage: NSImage?

    /// Post-install state: nil = not yet installed, true = success, false = error.
    var installState: InstallState = .ready

    enum InstallState {
        case ready
        case installing
        case installed
        case error(String)
    }

    init(
        response: OpenBundleResponseMessage,
        filePath: String,
        onConfirm: (() -> Void)? = nil,
        onCancel: (() -> Void)? = nil
    ) {
        self.manifest = response.manifest
        self.scanResult = response.scanResult
        self.signatureResult = response.signatureResult
        self.bundleSizeBytes = response.bundleSizeBytes
        self.filePath = filePath
        self.onConfirm = onConfirm
        self.onCancel = onCancel

        loadIcon()
    }

    // MARK: - Icon Loading

    /// Attempts to extract icon.png from the .vellum ZIP. Falls back to emoji rendering.
    private func loadIcon() {
        // Try extracting icon.png from the ZIP via unzip -p (stdout extraction)
        if !filePath.isEmpty {
            Task.detached { [filePath, manifest] in
                let image = Self.extractIconFromZip(filePath: filePath)
                    ?? Self.renderEmojiFallback(emoji: manifest.icon, appName: manifest.name)
                await MainActor.run { [image] in
                    self.appIconImage = image
                }
            }
        } else {
            appIconImage = Self.renderEmojiFallback(emoji: manifest.icon, appName: manifest.name)
        }
    }

    /// Extract icon.png from a .vellum ZIP without fully unpacking.
    private nonisolated static func extractIconFromZip(filePath: String) -> NSImage? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
        process.arguments = ["-p", filePath, "icon.png"]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe() // Suppress stderr

        do {
            try process.run()
        } catch {
            return nil
        }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        guard process.terminationStatus == 0, !data.isEmpty else { return nil }
        return NSImage(data: data)
    }

    /// Render the manifest emoji (or first letter) on a gradient background as a fallback icon.
    nonisolated static func renderEmojiFallback(emoji: String?, appName: String) -> NSImage {
        let glyph = (emoji.flatMap { $0.isEmpty ? nil : $0 })
            ?? String(appName.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1)).uppercased()

        let size: CGFloat = 512
        return NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            let cornerRadius = size * 0.22
            let path = NSBezierPath(roundedRect: rect, xRadius: cornerRadius, yRadius: cornerRadius)

            // Gradient background using a deterministic hash (djb2) for consistent colors across launches
            var hash: UInt64 = 5381
            for byte in glyph.utf8 {
                hash = hash &* 33 &+ UInt64(byte)
            }
            let hue = CGFloat(hash % 360) / 360.0
            let topColor = NSColor(hue: hue, saturation: 0.6, brightness: 0.85, alpha: 1.0)
            let bottomColor = NSColor(
                hue: (hue + 0.08).truncatingRemainder(dividingBy: 1.0),
                saturation: 0.7, brightness: 0.65, alpha: 1.0
            )
            if let gradient = NSGradient(starting: topColor, ending: bottomColor) {
                gradient.draw(in: path, angle: -90)
            }

            // Draw the glyph centered
            let fontSize = size * 0.55
            let attributes: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: fontSize),
            ]
            let emojiString = NSAttributedString(string: glyph, attributes: attributes)
            let emojiSize = emojiString.size()
            let origin = NSPoint(
                x: (size - emojiSize.width) / 2,
                y: (size - emojiSize.height) / 2
            )
            emojiString.draw(at: origin)
            return true
        }
    }

    // MARK: - Trust Tier

    enum TrustTier: String {
        case verified, signed, unsigned, tampered
    }

    var trustTier: TrustTier {
        TrustTier(rawValue: signatureResult.trustTier) ?? .unsigned
    }

    var isTampered: Bool {
        trustTier == .tampered
    }

    var isInstalling: Bool {
        if case .installing = installState { return true }
        return false
    }

    // MARK: - Formatted Size

    var formattedSize: String {
        let bytes = Double(bundleSizeBytes)
        if bytes < 1024 {
            return "\(bundleSizeBytes) B"
        } else if bytes < 1024 * 1024 {
            return String(format: "%.1f KB", bytes / 1024)
        } else if bytes < 1024 * 1024 * 1024 {
            return String(format: "%.1f MB", bytes / (1024 * 1024))
        } else {
            return String(format: "%.1f GB", bytes / (1024 * 1024 * 1024))
        }
    }

    // MARK: - Actions

    func confirm() {
        onConfirm?()
    }

    func cancel() {
        onCancel?()
    }
}
