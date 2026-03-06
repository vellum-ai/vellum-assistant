import VellumAssistantShared
import SwiftUI

@MainActor
struct BundleConfirmationView: View {
    var viewModel: BundleConfirmationViewModel

    var body: some View {
        VStack(spacing: 0) {
            switch viewModel.installState {
            case .installed:
                installedStateView
            case .installing:
                installingStateView
            case .error(let message):
                errorStateView(message: message)
            case .ready:
                confirmationContent
            }
        }
        .frame(width: 480, height: 400)
        .background(VColor.background)
    }

    // MARK: - Main Confirmation Content

    private var confirmationContent: some View {
        VStack(spacing: 0) {
            // Hero section — icon + name + description
            heroSection

            // Info section — trust, size, warnings
            infoSection

            Spacer(minLength: 0)

            Divider()
                .background(VColor.surfaceBorder)

            // Action buttons
            footerSection
        }
    }

    // MARK: - Hero Section

    private var heroSection: some View {
        VStack(spacing: VSpacing.md) {
            Spacer()
                .frame(height: VSpacing.xl)

            // App icon — 96pt centered with rounded corners and shadow
            Group {
                if let icon = viewModel.appIconImage {
                    Image(nsImage: icon)
                        .resizable()
                        .interpolation(.high)
                        .aspectRatio(contentMode: .fit)
                } else {
                    // Inline emoji fallback while icon loads
                    Text(viewModel.manifest.icon ?? "\u{1F4E6}")
                        .font(.system(size: 64))
                }
            }
            .frame(width: 96, height: 96)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
            .vShadow(VShadow.md)

            // App name
            Text(viewModel.manifest.name)
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)
                .multilineTextAlignment(.center)
                .lineLimit(2)

            // Description
            if let description = viewModel.manifest.description, !description.isEmpty {
                Text(description)
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .padding(.horizontal, VSpacing.xxl)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.bottom, VSpacing.lg)
    }

    // MARK: - Info Section

    private var infoSection: some View {
        VStack(spacing: VSpacing.sm) {
            // Trust tier badge — centered
            trustBadge

            // Signer info
            if let signerName = viewModel.signatureResult.signerDisplayName, !signerName.isEmpty {
                Text("Signed by \(signerName)")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
            }

            // Bundle size
            Text(viewModel.formattedSize)
                .font(VFont.caption)
                .foregroundColor(VColor.textMuted)

            // Security warnings — expandable disclosure
            if !viewModel.scanResult.warnings.isEmpty {
                warningsDisclosure
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, VSpacing.xl)
    }

    // MARK: - Trust Badge

    private var trustBadge: some View {
        HStack(spacing: VSpacing.xs) {
            trustBadgeIcon
            trustBadgeLabel
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.xs)
        .background(trustBadgeBackground)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.pill))
    }

    @ViewBuilder
    private var trustBadgeIcon: some View {
        switch viewModel.trustTier {
        case .verified:
            Image(systemName: "checkmark.seal.fill")
                .foregroundColor(VColor.success)
                .font(.system(size: 14))
        case .signed:
            Image(systemName: "checkmark.seal.fill")
                .foregroundColor(VColor.accent)
                .font(.system(size: 14))
        case .unsigned:
            Image(systemName: "lock.open")
                .foregroundColor(VColor.textSecondary)
                .font(.system(size: 12))
        case .tampered:
            Image(systemName: "xmark.seal.fill")
                .foregroundColor(VColor.error)
                .font(.system(size: 14))
        }
    }

    @ViewBuilder
    private var trustBadgeLabel: some View {
        switch viewModel.trustTier {
        case .verified:
            Text("Verified")
                .font(VFont.captionMedium)
                .foregroundColor(VColor.success)
        case .signed:
            Text("Signed")
                .font(VFont.captionMedium)
                .foregroundColor(VColor.accent)
        case .unsigned:
            Text("Not Signed")
                .font(VFont.captionMedium)
                .foregroundColor(VColor.textSecondary)
        case .tampered:
            Text("Tampered")
                .font(VFont.captionMedium)
                .foregroundColor(VColor.error)
        }
    }

    private var trustBadgeBackground: Color {
        switch viewModel.trustTier {
        case .verified: return VColor.success.opacity(0.15)
        case .signed: return VColor.accent.opacity(0.15)
        case .unsigned: return VColor.surface
        case .tampered: return VColor.error.opacity(0.15)
        }
    }

    // MARK: - Warnings Disclosure

    private var warningsDisclosure: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Button(action: {
                withAnimation(VAnimation.standard) {
                    viewModel.warningsExpanded.toggle()
                }
            }) {
                HStack(spacing: VSpacing.xs) {
                    Image(systemName: "exclamationmark.triangle")
                        .foregroundColor(VColor.warning)
                        .font(.system(size: 10))
                    Text("\(viewModel.scanResult.warnings.count) warning\(viewModel.scanResult.warnings.count == 1 ? "" : "s")")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                    Image(systemName: viewModel.warningsExpanded ? "chevron.up" : "chevron.down")
                        .foregroundColor(VColor.textMuted)
                        .font(.system(size: 8))
                }
            }
            .buttonStyle(.plain)

            if viewModel.warningsExpanded {
                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    ForEach(viewModel.scanResult.warnings, id: \.self) { warning in
                        Text("\u{2022} \(warning)")
                            .font(VFont.caption)
                            .foregroundColor(VColor.textSecondary)
                    }
                }
                .padding(.leading, VSpacing.lg)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(.top, VSpacing.xs)
    }

    // MARK: - Footer

    private var footerSection: some View {
        HStack(spacing: VSpacing.md) {
            VButton(label: "Cancel", style: .ghost, size: .medium) {
                viewModel.cancel()
            }

            Spacer()

            if viewModel.isTampered {
                tamperedInstallButton
            } else {
                VButton(label: "Install", style: .primary, size: .medium) {
                    viewModel.confirm()
                }
            }
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
    }

    @ViewBuilder
    private var tamperedInstallButton: some View {
        if viewModel.showTamperedWarning {
            VStack(alignment: .trailing, spacing: VSpacing.xxs) {
                Text("This app may have been modified.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
                VButton(label: "Install Anyway", style: .danger, size: .medium) {
                    viewModel.confirm()
                }
            }
        } else {
            VButton(label: "Install", style: .ghost, size: .medium) {
                withAnimation(VAnimation.standard) {
                    viewModel.showTamperedWarning = true
                }
            }
        }
    }

    // MARK: - Installing State

    private var installingStateView: some View {
        VStack(spacing: VSpacing.lg) {
            Spacer()

            ProgressView()
                .controlSize(.large)

            Text("Installing…")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .transition(.opacity)
    }

    // MARK: - Error State

    private func errorStateView(message: String) -> some View {
        VStack(spacing: VSpacing.lg) {
            Spacer()

            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 56))
                .foregroundColor(VColor.error)

            Text("Installation Failed")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)

            Text(message)
                .font(VFont.body)
                .foregroundColor(VColor.error)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xxl)

            VButton(label: "Dismiss", style: .ghost, size: .medium) {
                viewModel.cancel()
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .transition(.opacity)
    }

    // MARK: - Installed State

    private var installedStateView: some View {
        VStack(spacing: VSpacing.lg) {
            Spacer()

            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 56))
                .foregroundColor(VColor.success)

            Text("Installed")
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .transition(.opacity)
    }
}
