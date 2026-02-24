// The macOS build uses its own AppKit-based AvatarAppearanceManager (which supports
// NSImage caching and NSOpenPanel for custom avatar upload). On other platforms we use
// this lighter cross-platform version.
#if !os(macOS)
import Foundation
import SwiftUI

/// Manages avatar appearance (palette, outfit, config) from LOOKS.md.
/// Cross-platform: watches for file changes on all supported platforms.
/// @Observable so SwiftUI views reactively update.
@MainActor @Observable
public final class AvatarAppearanceManager {
    public private(set) var palette: DinoPalette = .violet
    public private(set) var outfit: DinoOutfit = .none
    public private(set) var config: LooksConfig = .default
    private var fileMonitor: DispatchSourceFileSystemObject?

    public static let shared = AvatarAppearanceManager()

    public var looksPath: String {
        homeDirectory + "/.vellum/workspace/LOOKS.md"
    }

    private var homeDirectory: String {
        NSHomeDirectory()
    }

    public func start() {
        reload()
        watchFile()
    }

    private func reload() {
        guard let content = try? String(contentsOfFile: looksPath, encoding: .utf8) else {
            return
        }
        config = LooksConfig.parse(from: content)
        palette = config.toPalette()
        outfit = config.toOutfit()
    }

    private func watchFile() {
        fileMonitor?.cancel()
        fileMonitor = nil

        let path = looksPath
        let fd = open(path, O_EVTONLY)

        if fd < 0 {
            // File doesn't exist yet — watch the parent directory for creation
            watchDirectory()
            return
        }

        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .delete, .rename],
            queue: .global(qos: .utility)
        )

        source.setEventHandler { [weak self] in
            let flags = source.data
            Task { @MainActor [weak self] in
                self?.reload()
                // Re-watch in case of delete+recreate
                if flags.contains(.delete) || flags.contains(.rename) {
                    self?.watchFile()
                }
            }
        }

        source.setCancelHandler {
            close(fd)
        }

        fileMonitor = source
        source.resume()
    }

    /// Watches the workspace directory for LOOKS.md creation, then switches to file-level watching.
    private func watchDirectory() {
        let dirPath = (looksPath as NSString).deletingLastPathComponent
        let fd = open(dirPath, O_EVTONLY)
        guard fd >= 0 else { return }

        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: .write,
            queue: .global(qos: .utility)
        )

        source.setEventHandler { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if FileManager.default.fileExists(atPath: self.looksPath) {
                    self.reload()
                    self.watchFile()
                }
            }
        }

        source.setCancelHandler {
            close(fd)
        }

        fileMonitor = source
        source.resume()
    }

    // MARK: - Evolution Write-Back

    /// Write a resolved LooksConfig to LOOKS.md.
    /// Only writes if the config actually changed from current.
    public func applyEvolutionResult(_ newConfig: LooksConfig) {
        guard newConfig != config else { return }

        let content = """
        - **Body:** \(newConfig.bodyColor)
        - **Cheeks:** \(newConfig.cheekColor)
        - **Hat:** \(formatOutfitField(newConfig.hat, color: newConfig.hatColor))
        - **Shirt:** \(formatOutfitField(newConfig.shirt, color: newConfig.shirtColor))
        - **Accessory:** \(formatOutfitField(newConfig.accessory, color: newConfig.accessoryColor))
        - **Held Item:** \(newConfig.heldItem)
        """

        try? content.write(toFile: looksPath, atomically: true, encoding: .utf8)

        // Apply in-process immediately instead of waiting for the file watcher round-trip.
        // The file watcher still handles external edits to LOOKS.md.
        config = newConfig
        palette = newConfig.toPalette()
        outfit = newConfig.toOutfit()
    }

    private func formatOutfitField(_ item: String, color: String?) -> String {
        if let color = color, color != "none" {
            return "\(item) (\(color))"
        }
        return item
    }
}
#endif
