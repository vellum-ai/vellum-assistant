import AppKit
import SwiftUI
import VellumAssistantShared

/// Referral panel — shows referral URL, copy button, stats, and earning cap.
@MainActor
struct SettingsBillingReferralCard: View {
    @State private var referralCode: ReferralCodeResponse?
    @State private var isLoading: Bool = true
    @State private var isCreating: Bool = false
    @State private var error: String?
    @State private var hasNoCode: Bool = false
    @State private var copied: Bool = false

    var body: some View {
        Group {
            if isLoading {
                loadingState
            } else if let error {
                errorState(error)
            } else if hasNoCode {
                noCodeState
            } else if let referralCode {
                hasCodeState(referralCode)
            }
        }
        .task {
            await loadReferralCode()
        }
    }

    // MARK: - Loading State

    private var loadingState: some View {
        SettingsCard(title: "Referrals") {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                VSkeletonBone(height: 28)
                HStack(spacing: VSpacing.xl) {
                    VSkeletonBone(width: 80, height: 14)
                    VSkeletonBone(width: 80, height: 14)
                }
            }
            .accessibilityHidden(true)
        }
    }

    // MARK: - No Code State

    private var noCodeState: some View {
        SettingsCard(title: "Referrals", subtitle: "Share your link and earn credits") {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                Text("Get your personal referral link to share with friends. You'll both earn credits when they sign up.")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)

                VButton(
                    label: isCreating ? "Creating..." : "Get Referral Link",
                    style: .primary,
                    isDisabled: isCreating
                ) {
                    Task { await createCode() }
                }
            }
        }
    }

    // MARK: - Has Code State

    private func hasCodeState(_ code: ReferralCodeResponse) -> some View {
        SettingsCard(title: "Referrals", subtitle: "Share your link and earn credits") {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                // Referral URL row
                HStack(spacing: VSpacing.sm) {
                    Text(code.referral_url)
                        .font(.custom("DMMono-Regular", size: 13))
                        .foregroundStyle(VColor.contentDefault)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(VSpacing.sm)
                        .background(VColor.surfaceBase)
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.md)
                                .stroke(VColor.borderBase, lineWidth: 1)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))

                    VButton(
                        label: "",
                        iconOnly: copied ? VIcon.check.rawValue : VIcon.copy.rawValue,
                        style: .ghost
                    ) {
                        copyToClipboard(code.referral_url)
                    }
                }

                SettingsDivider()

                // Stats row
                HStack(spacing: VSpacing.xl) {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.users, size: 14)
                                .foregroundStyle(VColor.contentSecondary)
                            Text("Friends Referred")
                                .font(VFont.bodySmallDefault)
                                .foregroundStyle(VColor.contentSecondary)
                        }
                        Text("\(code.referred_count)")
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentEmphasized)
                    }

                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.creditCard, size: 14)
                                .foregroundStyle(VColor.contentSecondary)
                            Text("Credits Earned")
                                .font(VFont.bodySmallDefault)
                                .foregroundStyle(VColor.contentSecondary)
                        }
                        Text("$\(code.total_earned_usd)")
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentEmphasized)
                    }
                }

                // Earning cap note
                Text("Earn up to $\(code.earning_cap_usd) in referral credits")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
        }
    }

    // MARK: - Error State

    private func errorState(_ message: String) -> some View {
        SettingsCard(title: "Referrals") {
            VStack(alignment: .leading, spacing: VSpacing.md) {
                HStack(spacing: VSpacing.sm) {
                    VIconView(.circleAlert, size: 14)
                        .foregroundStyle(VColor.systemNegativeStrong)
                    Text(message)
                        .font(VFont.bodyMediumLighter)
                        .foregroundStyle(VColor.systemNegativeStrong)
                }
                VButton(label: "Try Again", style: .outlined) {
                    Task { await loadReferralCode() }
                }
            }
        }
    }

    // MARK: - Actions

    private func loadReferralCode() async {
        if referralCode == nil {
            isLoading = true
        }
        error = nil
        do {
            let result = try await BillingService.shared.getReferralCode()
            referralCode = result
            hasNoCode = false
        } catch PlatformAPIError.notFound {
            hasNoCode = true
        } catch {
            if referralCode == nil {
                self.error = "Failed to load referral information."
            }
        }
        isLoading = false
    }

    private func createCode() async {
        isCreating = true
        defer { isCreating = false }
        do {
            let result = try await BillingService.shared.createReferralCode()
            referralCode = result
            hasNoCode = false
        } catch {
            self.error = "Failed to create referral code. Please try again."
        }
    }

    private func copyToClipboard(_ url: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url, forType: .string)
        copied = true
        Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            copied = false
        }
    }
}
