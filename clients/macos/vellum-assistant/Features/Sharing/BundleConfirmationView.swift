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
        .background(VColor.surfaceLift)
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
                .background(VColor.borderBase)

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
                .font(VFont.titleMedium)
                .foregroundStyle(VColor.contentDefault)
                .multilineTextAlignment(.center)
                .lineLimit(2)

            // Description
            if let description = viewModel.manifest.description, !description.isEmpty {
                Text(description)
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)
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
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }

            // Bundle size
            Text(viewModel.formattedSize)
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)

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
            VIconView(.badgeCheck, size: 14)
                .foregroundStyle(VColor.systemPositiveStrong)
        case .signed:
            VIconView(.badgeCheck, size: 14)
                .foregroundStyle(VColor.primaryBase)
        case .unsigned:
            VIconView(.lockOpen, size: 12)
                .foregroundStyle(VColor.contentSecondary)
        case .tampered:
            VIconView(.badgeX, size: 14)
                .foregroundStyle(VColor.systemNegativeStrong)
        }
    }

    @ViewBuilder
    private var trustBadgeLabel: some View {
        switch viewModel.trustTier {
        case .verified:
            Text("Verified")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.systemPositiveStrong)
        case .signed:
            Text("Signed")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.primaryBase)
        case .unsigned:
            Text("Not Signed")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentSecondary)
        case .tampered:
            Text("Tampered")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.systemNegativeStrong)
        }
    }

    private var trustBadgeBackground: Color {
        switch viewModel.trustTier {
        case .verified: return VColor.systemPositiveStrong.opacity(0.15)
        case .signed: return VColor.primaryBase.opacity(0.15)
        case .unsigned: return VColor.surfaceBase
        case .tampered: return VColor.systemNegativeStrong.opacity(0.15)
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
                    VIconView(.triangleAlert, size: 10)
                        .foregroundStyle(VColor.systemNegativeHover)
                    Text("\(viewModel.scanResult.warnings.count) warning\(viewModel.scanResult.warnings.count == 1 ? "" : "s")")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                    VIconView(viewModel.warningsExpanded ? .chevronUp : .chevronDown, size: 8)
                        .foregroundStyle(VColor.contentTertiary)
                }
            }
            .buttonStyle(.plain)

            if viewModel.warningsExpanded {
                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    ForEach(viewModel.scanResult.warnings, id: \.self) { warning in
                        Text("\u{2022} \(warning)")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentSecondary)
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
        HStack(spacing: VSpacing.sm) {
            Spacer()

            VButton(label: "Cancel", style: .outlined) {
                viewModel.cancel()
            }

            if viewModel.isTampered {
                tamperedInstallButton
            } else {
                VButton(label: "Install", style: .primary) {
                    viewModel.confirm()
                }
                .disabled(viewModel.isInstalling)
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
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
                VButton(label: "Install Anyway", style: .danger) {
                    viewModel.confirm()
                }
                .disabled(viewModel.isInstalling)
            }
        } else {
            VButton(label: "Install", style: .outlined) {
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
                .font(VFont.titleMedium)
                .foregroundStyle(VColor.contentDefault)

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .transition(.opacity)
    }

    // MARK: - Error State

    private func errorStateView(message: String) -> some View {
        VStack(spacing: VSpacing.lg) {
            Spacer()

            VIconView(.circleX, size: 56)
                .foregroundStyle(VColor.systemNegativeStrong)

            Text("Installation Failed")
                .font(VFont.titleMedium)
                .foregroundStyle(VColor.contentDefault)

            Text(message)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.systemNegativeStrong)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xxl)

            VButton(label: "Dismiss", style: .outlined) {
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

            VIconView(.circleCheck, size: 56)
                .foregroundStyle(VColor.systemPositiveStrong)

            Text("Installed")
                .font(VFont.titleMedium)
                .foregroundStyle(VColor.contentDefault)

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .transition(.opacity)
    }
}
