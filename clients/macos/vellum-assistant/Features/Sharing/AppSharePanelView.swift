import AppKit
import SwiftUI
import VellumAssistantShared

/// Custom share panel that replaces NSSharingServicePicker, showing the app icon
/// prominently in the header instead of a blank document icon.
struct AppSharePanelView: View {
    let fileURL: URL
    let appName: String
    let appIcon: NSImage?
    let appId: String?
    let gatewayBaseURL: String
    let onDismiss: () -> Void

    @State private var services: [NSSharingService] = []
    @State private var hoveredServiceIndex: Int?
    @State private var formattedFileSize: String = ""

    @available(macOS, deprecated: 13.0)
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            servicesListView
        }
        .frame(width: 240)
        .onDisappear {
            hoveredServiceIndex = nil
        }
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.borderBase, lineWidth: 1)
        )
        .shadow(color: VColor.auxBlack.opacity(0.15), radius: 6, y: 2)
        .onAppear {
            services = Self.availableSharingServices(for: fileURL)
        }
        .task {
            formattedFileSize = await computeFileSize()
        }
    }

    // MARK: - Services List

    @available(macOS, deprecated: 13.0)
    private var servicesListView: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header: app icon, name, file size
            header
                .padding(VSpacing.lg)

            VColor.borderBase.frame(height: 1)

            // Services list
            ScrollView {
                VStack(spacing: 0) {
                    // Download and share — saves to Downloads and reveals in Finder
                    serviceRow(
                        icon: VIcon.arrowDownToLine.nsImage,
                        title: "Download and Share",
                        index: -3
                    ) {
                        saveToDownloads()
                    }

                    // System sharing services
                    ForEach(Array(services.enumerated()), id: \.offset) { index, service in
                        serviceRow(
                            icon: service.image,
                            title: service.title,
                            index: index
                        ) {
                            service.perform(withItems: [fileURL])
                            onDismiss()
                        }
                    }

                    VColor.borderBase.frame(height: 1)
                        .padding(.horizontal, VSpacing.xs)
                        .padding(.vertical, VSpacing.xs)

                    // Copy row
                    serviceRow(
                        icon: VIcon.copy.nsImage,
                        title: "Copy",
                        index: -1
                    ) {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.writeObjects([fileURL as NSURL])
                        onDismiss()
                    }
                }
                .padding(.vertical, VSpacing.xs)
            }
            .frame(maxHeight: 300)
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: VSpacing.md) {
            // App icon at 64x64
            Group {
                if let icon = appIcon {
                    Image(nsImage: icon)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                } else {
                    // Fallback: first letter of app name
                    ZStack {
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .fill(VColor.surfaceBase)
                        Text(String(appName.prefix(1)).uppercased())
                            .font(.system(size: 28, weight: .bold))
                            .foregroundColor(VColor.contentSecondary)
                    }
                }
            }
            .frame(width: 64, height: 64)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text(appName)
                    .font(VFont.headline)
                    .foregroundColor(VColor.contentDefault)
                    .lineLimit(2)

                Text(formattedFileSize)
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
            }
        }
    }

    // MARK: - Service Row

    private func serviceRow(
        icon: NSImage?,
        title: String,
        index: Int,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: VSpacing.sm) {
                if let icon {
                    Image(nsImage: icon)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .frame(width: 18, height: 18)
                } else {
                    Color.clear.frame(width: 18, height: 18)
                }

                Text(title)
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)

                Spacer()
            }
            .padding(.horizontal, VSpacing.md)
            .padding(.vertical, VSpacing.sm)
            .background(VColor.surfaceBase.opacity(hoveredServiceIndex == index ? 1 : 0))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            hoveredServiceIndex = hovering ? index : nil
        }
        .pointerCursor()
    }

    // MARK: - Helpers

    /// Queries available sharing services. The API was deprecated in macOS 13 in favor of
    /// NSSharingServicePicker.standardShareMenuItem, but the replacement doesn't expose
    /// individual services for custom UI. No functional replacement exists.
    @available(macOS, deprecated: 13.0)
    private static func availableSharingServices(for url: URL) -> [NSSharingService] {
        NSSharingService.sharingServices(forItems: [url])
    }

    private func computeFileSize() async -> String {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: fileURL.path, isDirectory: &isDirectory) else {
            return ""
        }
        if isDirectory.boolValue {
            let url = fileURL
            let size = await Task.detached {
                Self.directorySize(at: url)
            }.value
            return size
                .map { ByteCountFormatter.string(fromByteCount: Int64($0), countStyle: .file) }
                ?? "App Bundle"
        }
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: fileURL.path),
              let size = attrs[.size] as? UInt64 else {
            return ""
        }
        return ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)
    }

    /// Recursively computes the total size of all files within a directory.
    nonisolated private static func directorySize(at url: URL) -> UInt64? {
        guard let enumerator = FileManager.default.enumerator(
            at: url,
            includingPropertiesForKeys: [.fileSizeKey, .isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else {
            return nil
        }
        var total: UInt64 = 0
        for case let fileURL as URL in enumerator {
            guard let resourceValues = try? fileURL.resourceValues(forKeys: [.fileSizeKey, .isDirectoryKey]),
                  resourceValues.isDirectory != true,
                  let fileSize = resourceValues.fileSize else {
                continue
            }
            total += UInt64(fileSize)
        }
        return total
    }

    private func saveToDownloads() {
        let downloads = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first!
        let destURL = downloads.appendingPathComponent(fileURL.lastPathComponent)

        // If the file already exists, generate a unique name
        var finalURL = destURL
        var counter = 1
        while FileManager.default.fileExists(atPath: finalURL.path) {
            let stem = destURL.deletingPathExtension().lastPathComponent
            let ext = destURL.pathExtension
            finalURL = downloads.appendingPathComponent("\(stem) \(counter).\(ext)")
            counter += 1
        }

        do {
            try FileManager.default.copyItem(at: fileURL, to: finalURL)
            NSWorkspace.shared.activateFileViewerSelecting([finalURL])
        } catch {
            // Fallback: just reveal the original file
            NSWorkspace.shared.activateFileViewerSelecting([fileURL])
        }
        onDismiss()
    }
}
