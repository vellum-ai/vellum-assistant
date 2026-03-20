import AppKit
import os

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "AppBundleRenamer"
)

/// Renames the running .app bundle back to "Vellum" and relaunches.
///
/// Development builds name the .app bundle after the active assistant
/// (e.g. "Jarvis.app") via `build.sh` reading `~/.vellum/.dock-display-name`.
/// When the last assistant is retired, the dock label should revert to
/// "Vellum". Since `CFBundleDisplayName` is baked into Info.plist at build
/// time and cannot be changed at runtime without breaking the code signature,
/// this utility spawns a detached shell script that waits for the app to
/// exit, renames the bundle in-place, re-signs it, and relaunches it.
///
/// Production builds always use "Vellum" so this is a no-op for them.
enum AppBundleRenamer {

    private static let targetName = AppDelegate.appName

    /// Returns `true` if the current bundle's display name differs from
    /// "Vellum" and a rename + relaunch is needed.
    static var needsRename: Bool {
        let current = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
            ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String
            ?? targetName
        return current != targetName
    }

    /// Spawns a detached shell script that renames the bundle and relaunches,
    /// then terminates the current process. Returns `false` on failure so the
    /// caller can fall through to `showOnboarding()`.
    @discardableResult
    static func renameAndRelaunch() -> Bool {
        let bundleURL = Bundle.main.bundleURL
        let bundleDir = bundleURL.deletingLastPathComponent()
        let currentAppName = bundleURL.deletingPathExtension().lastPathComponent
        let currentExeName = Bundle.main.object(forInfoDictionaryKey: "CFBundleExecutable") as? String
            ?? currentAppName
        let bundleId = Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant"
        let pid = ProcessInfo.processInfo.processIdentifier

        // Verify we can write to the parent directory (e.g. dist/).
        // /Applications/ requires elevated privileges — skip the rename there
        // (production builds installed to /Applications/ are always "Vellum").
        guard FileManager.default.isWritableFile(atPath: bundleDir.path) else {
            log.warning("Bundle parent directory is not writable, skipping rename")
            return false
        }

        let script = """
        #!/bin/bash
        set -euo pipefail

        # Wait for the app to exit (up to 10 seconds)
        for i in $(seq 1 100); do
            kill -0 \(pid) 2>/dev/null || break
            sleep 0.1
        done

        APP_DIR='\(bundleURL.path)'
        CONTENTS="$APP_DIR/Contents"
        MACOS="$CONTENTS/MacOS"
        OLD_EXE='\(currentExeName)'
        NEW_NAME='\(targetName)'
        BUNDLE_DIR='\(bundleDir.path)'
        BUNDLE_ID='\(bundleId)'
        TARGET_APP="$BUNDLE_DIR/$NEW_NAME.app"

        # 1. Rename the executable
        if [ -f "$MACOS/$OLD_EXE" ] && [ "$OLD_EXE" != "$NEW_NAME" ]; then
            mv "$MACOS/$OLD_EXE" "$MACOS/$NEW_NAME"
        fi

        # 2. Update Info.plist
        PLIST="$CONTENTS/Info.plist"
        if [ -f "$PLIST" ]; then
            /usr/libexec/PlistBuddy -c "Set :CFBundleExecutable $NEW_NAME" "$PLIST"
            /usr/libexec/PlistBuddy -c "Set :CFBundleName $NEW_NAME" "$PLIST"
            /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $NEW_NAME" "$PLIST"
        fi

        # 3. Rename the .app directory
        if [ "$APP_DIR" != "$TARGET_APP" ]; then
            [ -d "$TARGET_APP" ] && rm -rf "$TARGET_APP"
            mv "$APP_DIR" "$TARGET_APP"
        fi

        # 4. Re-sign the outer app bundle (ad-hoc, preserves nested signatures)
        codesign --force --sign - "$TARGET_APP" 2>/dev/null || true

        # 5. Clean up stale .app bundles with the same bundle identifier
        for stale in "$BUNDLE_DIR"/*.app; do
            [ "$stale" = "$TARGET_APP" ] && continue
            [ ! -d "$stale" ] && continue
            STALE_ID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" \
                "$stale/Contents/Info.plist" 2>/dev/null || echo "")
            if [ "$STALE_ID" = "$BUNDLE_ID" ]; then
                rm -rf "$stale"
            fi
        done

        # 6. Relaunch
        open "$TARGET_APP"

        # 7. Self-delete
        rm -f "$0"
        """

        let scriptURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("vellum-rename-\(UUID().uuidString).sh")

        do {
            try script.write(to: scriptURL, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o755],
                ofItemAtPath: scriptURL.path
            )
        } catch {
            log.error("Failed to write rename script: \(error.localizedDescription)")
            return false
        }

        // Write restart sentinel so the relaunched instance passes the
        // single-instance guard (same pattern as performRestart).
        let sentinelDir = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(".vellum")
        try? FileManager.default.createDirectory(
            at: sentinelDir, withIntermediateDirectories: true
        )
        let sentinelPath = sentinelDir.appendingPathComponent("restart-in-progress")
        let timestamp = "\(Date().timeIntervalSince1970)"
        try? timestamp.write(to: sentinelPath, atomically: true, encoding: .utf8)

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/bash")
        proc.arguments = [scriptURL.path]
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        proc.qualityOfService = .utility

        do {
            try proc.run()
            log.info("Rename script launched (pid \(proc.processIdentifier)), terminating for relaunch")
        } catch {
            log.error("Failed to launch rename script: \(error.localizedDescription)")
            try? FileManager.default.removeItem(at: sentinelPath)
            try? FileManager.default.removeItem(at: scriptURL)
            return false
        }

        NSApp.terminate(nil)
        return true // unreachable but satisfies the compiler
    }
}
