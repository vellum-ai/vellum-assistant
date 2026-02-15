import Foundation
import SwiftUI
import VellumAssistantShared

@MainActor
@Observable
final class BundleConfirmationViewModel {
    let manifest: OpenBundleResponseMessage.Manifest
    let scanResult: OpenBundleResponseMessage.ScanResult
    let signatureResult: OpenBundleResponseMessage.SignatureResult
    let bundleSizeBytes: Int
    let filePath: String

    var onConfirm: (() -> Void)?
    var onCancel: (() -> Void)?

    var showTamperedWarning = false
    var warningsExpanded = false

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
