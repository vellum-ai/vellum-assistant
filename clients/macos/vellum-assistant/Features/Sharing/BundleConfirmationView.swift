import SwiftUI

struct BundleConfirmationView: View {
    @ObservedObject var viewModel: BundleConfirmationViewModel

    var body: some View {
        VStack(spacing: 0) {
            // Header
            headerSection

            Divider()
                .background(VColor.surfaceBorder)

            // Content
            ScrollView {
                VStack(alignment: .leading, spacing: VSpacing.lg) {
                    trustTierSection
                    scanResultSection
                    bundleSizeSection
                }
                .padding(VSpacing.xl)
            }

            Divider()
                .background(VColor.surfaceBorder)

            // Footer buttons
            footerSection
        }
        .background(VColor.background)
    }

    // MARK: - Header

    private var headerSection: some View {
        VStack(spacing: VSpacing.sm) {
            Text(viewModel.manifest.icon ?? "\u{1F4E6}")
                .font(.system(size: 40))

            Text(viewModel.manifest.name)
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)
                .multilineTextAlignment(.center)

            if let description = viewModel.manifest.description, !description.isEmpty {
                Text(description)
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
            }

            Text("by \(viewModel.manifest.createdBy)")
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)
        }
        .padding(VSpacing.xl)
        .frame(maxWidth: .infinity)
    }

    // MARK: - Trust Tier

    private var trustTierSection: some View {
        HStack(spacing: VSpacing.sm) {
            trustTierIcon
            trustTierText
        }
        .padding(VSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(trustTierBackground)
        .cornerRadius(VRadius.md)
    }

    @ViewBuilder
    private var trustTierIcon: some View {
        switch viewModel.trustTier {
        case .verified:
            Image(systemName: "checkmark.seal.fill")
                .foregroundColor(VColor.success)
        case .signed:
            Image(systemName: "info.circle.fill")
                .foregroundColor(VColor.textSecondary)
        case .unsigned:
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundColor(VColor.warning)
        case .tampered:
            Image(systemName: "xmark.seal.fill")
                .foregroundColor(VColor.error)
        }
    }

    @ViewBuilder
    private var trustTierText: some View {
        switch viewModel.trustTier {
        case .verified:
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text("Verified")
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.success)
                Text("Created by \(viewModel.signatureResult.signerDisplayName ?? "Unknown") (\(viewModel.signatureResult.signerAccount ?? ""))")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
            }
        case .signed:
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text("Signed")
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)
                let keyId = viewModel.signatureResult.signerKeyId ?? "unknown"
                let shortKey = keyId.count > 8 ? String(keyId.prefix(8)) + "..." : keyId
                Text("Created by an unverified user (key: \(shortKey)). Content not modified.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
            }
        case .unsigned:
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text("Unsigned")
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.warning)
                Text("This app is unsigned.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
            }
        case .tampered:
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text("Tampered")
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.error)
                Text("This app has been modified since it was signed.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
            }
        }
    }

    private var trustTierBackground: Color {
        switch viewModel.trustTier {
        case .verified:
            return VColor.success.opacity(0.1)
        case .signed:
            return VColor.surface
        case .unsigned:
            return VColor.warning.opacity(0.1)
        case .tampered:
            return VColor.error.opacity(0.1)
        }
    }

    // MARK: - Scan Result

    @ViewBuilder
    private var scanResultSection: some View {
        if !viewModel.scanResult.blocked.isEmpty {
            // Blocked state (should not normally reach here)
            HStack(spacing: VSpacing.sm) {
                Image(systemName: "xmark.circle.fill")
                    .foregroundColor(VColor.error)
                Text("Security scan blocked")
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.error)
            }
            .padding(VSpacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(VColor.error.opacity(0.1))
            .cornerRadius(VRadius.md)
        } else if !viewModel.scanResult.warnings.isEmpty {
            // Warnings
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Button(action: { viewModel.warningsExpanded.toggle() }) {
                    HStack(spacing: VSpacing.sm) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundColor(VColor.warning)
                        Text("Security scan: \(viewModel.scanResult.warnings.count) warning\(viewModel.scanResult.warnings.count == 1 ? "" : "s")")
                            .font(VFont.bodyMedium)
                            .foregroundColor(VColor.warning)
                        Spacer()
                        Image(systemName: viewModel.warningsExpanded ? "chevron.up" : "chevron.down")
                            .foregroundColor(VColor.textSecondary)
                            .font(.system(size: 10))
                    }
                }
                .buttonStyle(.plain)

                if viewModel.warningsExpanded {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        ForEach(viewModel.scanResult.warnings, id: \.self) { warning in
                            HStack(alignment: .top, spacing: VSpacing.sm) {
                                Text("\u{2022}")
                                    .foregroundColor(VColor.warning)
                                Text(warning)
                                    .font(VFont.caption)
                                    .foregroundColor(VColor.textSecondary)
                            }
                        }
                    }
                    .padding(.leading, VSpacing.xl)
                }
            }
            .padding(VSpacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(VColor.warning.opacity(0.1))
            .cornerRadius(VRadius.md)
        } else {
            // Clean scan
            HStack(spacing: VSpacing.sm) {
                Image(systemName: "checkmark.shield.fill")
                    .foregroundColor(VColor.success)
                Text("Security scan passed")
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.success)
            }
            .padding(VSpacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(VColor.success.opacity(0.1))
            .cornerRadius(VRadius.md)
        }
    }

    // MARK: - Bundle Size

    private var bundleSizeSection: some View {
        HStack(spacing: VSpacing.sm) {
            Image(systemName: "doc.zipper")
                .foregroundColor(VColor.textSecondary)
            Text("Bundle size: \(viewModel.formattedSize)")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
        }
    }

    // MARK: - Footer

    private var footerSection: some View {
        HStack(spacing: VSpacing.md) {
            // Cancel button
            Button(action: { viewModel.cancel() }) {
                Text("Cancel")
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textSecondary)
                    .padding(.vertical, VSpacing.buttonV)
                    .padding(.horizontal, VSpacing.lg)
            }
            .buttonStyle(.plain)
            .background(VColor.surface)
            .cornerRadius(VRadius.md)

            Spacer()

            if viewModel.isTampered {
                if viewModel.showTamperedWarning {
                    // Show "Open Anyway" destructive button
                    VStack(alignment: .trailing, spacing: VSpacing.xs) {
                        Text("This app may contain malicious content.")
                            .font(VFont.caption)
                            .foregroundColor(VColor.error)
                        Button(action: { viewModel.confirm() }) {
                            Text("Open Anyway")
                                .font(VFont.bodyMedium)
                                .foregroundColor(VColor.error)
                                .padding(.vertical, VSpacing.buttonV)
                                .padding(.horizontal, VSpacing.lg)
                        }
                        .buttonStyle(.plain)
                        .background(VColor.error.opacity(0.2))
                        .cornerRadius(VRadius.md)
                    }
                } else {
                    Button(action: { viewModel.showTamperedWarning = true }) {
                        Text("Open Anyway...")
                            .font(VFont.bodyMedium)
                            .foregroundColor(VColor.textSecondary)
                            .padding(.vertical, VSpacing.buttonV)
                            .padding(.horizontal, VSpacing.lg)
                    }
                    .buttonStyle(.plain)
                    .background(VColor.surface)
                    .cornerRadius(VRadius.md)
                }
            } else {
                // Normal "Open in Vellum" button
                Button(action: { viewModel.confirm() }) {
                    Text("Open in Vellum")
                        .font(VFont.bodyMedium)
                        .foregroundColor(VColor.textPrimary)
                        .padding(.vertical, VSpacing.buttonV)
                        .padding(.horizontal, VSpacing.lg)
                }
                .buttonStyle(.plain)
                .background(VColor.accent)
                .cornerRadius(VRadius.md)
            }
        }
        .padding(VSpacing.lg)
    }
}
