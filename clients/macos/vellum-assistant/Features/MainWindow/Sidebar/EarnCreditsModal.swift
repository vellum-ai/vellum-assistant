import AppKit
import SwiftUI
import VellumAssistantShared

/// Modal that surfaces the referral program — how it works, invite link, stats, and terms.
/// Presented from the "Earn credits" row in the preferences drawer.
@MainActor
struct EarnCreditsModal: View {
    @Environment(\.dismiss) private var dismiss

    @State private var referralCode: ReferralCodeResponse?
    @State private var isLoading: Bool = true
    @State private var error: String?
    @State private var copied: Bool = false
    @State private var copyResetTask: Task<Void, Never>?
    @State private var showTerms: Bool = false

    var body: some View {
        VModal(
            title: showTerms ? "" : "Earn free credits",
            subtitle: showTerms ? nil : "Share Vellum with friends and earn credits when they subscribe.",
            closeAction: { dismiss() },
            backAction: showTerms ? { withAnimation { showTerms = false } } : nil
        ) {
            if showTerms {
                termsContent
            } else if isLoading {
                loadingContent
            } else if let error {
                errorContent(error)
            } else if let referralCode {
                mainContent(referralCode)
            }
        }
        .frame(width: 420)
        .task {
            await loadReferralCode()
        }
    }

    // MARK: - Main Content

    private func mainContent(_ code: ReferralCodeResponse) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xl) {
            howItWorks(code)
            referralLinkSection(code)
            statsSection(code)
            termsLink
        }
        .padding(.bottom, VSpacing.lg)
    }

    // MARK: - How It Works

    private func howItWorks(_ code: ReferralCodeResponse) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            Text("How it works")
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentSecondary)

            howItWorksStep(
                icon: .share,
                title: "Share your invite link",
                subtitle: "Send your personal referral link to friends"
            )

            howItWorksStep(
                icon: .users,
                title: "They sign up",
                subtitle: "Your friend creates a Vellum account"
            )

            let capFormatted = code.earning_cap.replacingOccurrences(of: ".00", with: "")
            howItWorksStep(
                icon: .gift,
                title: "You earn credits",
                subtitle: "Get credits when they subscribe (up to \(capFormatted) total)"
            )
        }
    }

    private func howItWorksStep(icon: VIcon, title: String, subtitle: String) -> some View {
        HStack(alignment: .top, spacing: VSpacing.md) {
            VIconView(icon, size: 14)
                .foregroundStyle(VColor.primaryBase)
                .frame(width: 28, height: 28)
                .background(VColor.primaryBase.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                Text(subtitle)
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }
        }
    }

    // MARK: - Referral Link

    private func referralLinkSection(_ code: ReferralCodeResponse) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            SettingsDivider()

            HStack(spacing: VSpacing.sm) {
                Text(code.referral_url)
                    .font(.custom("DMMono-Regular", size: 13))
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(VSpacing.sm)
                    .background(VColor.surfaceBase)
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.borderBase, lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.md))

                VButton(
                    label: copied ? "Copied" : "Copy referral link",
                    iconOnly: copied ? VIcon.check.rawValue : VIcon.copy.rawValue,
                    style: .primary
                ) {
                    copyToClipboard(code.referral_url)
                }
            }
        }
    }

    // MARK: - Stats

    private func statsSection(_ code: ReferralCodeResponse) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            SettingsDivider()

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
                    Text("\(code.total_earned.replacingOccurrences(of: ".00", with: "")) credits")
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentEmphasized)
                }
            }
        }
    }

    // MARK: - Terms Link

    private var termsLink: some View {
        Button {
            withAnimation { showTerms = true }
        } label: {
            Text("View Terms and Conditions")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity, alignment: .center)
    }

    // MARK: - Terms Content

    private var termsContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            Text("Referral Program Terms")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)

            VStack(alignment: .leading, spacing: VSpacing.md) {
                termsBullet("This promotion is available to new users who sign up through your referral link only.")
                termsBullet("Rewards are earned once your invitee creates a new account and subscribes to a paid plan.")
                termsBullet("We do not grant credits for disposable or high-risk email accounts.")
                termsBullet("Each new user can generate only one (1) reward. No stacking or loophole hunting.")
                termsBullet("Please avoid spamming or misusing your referral link. Our systems actively monitor referral engagement.")
                termsBullet("If we detect suspicious or non-compliant activity, we reserve the right to withhold rewards or deactivate your referral link.")
                termsBullet("We may update, pause, or discontinue this program at any time.")
            }
        }
        .padding(.bottom, VSpacing.lg)
    }

    private func termsBullet(_ text: String) -> some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            Text("\u{2022}")
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentSecondary)
            Text(text)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentSecondary)
        }
    }

    // MARK: - Loading

    private var loadingContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            VSkeletonBone(width: 120, height: 14)
            VSkeletonBone(height: 20)
            VSkeletonBone(height: 20)
            VSkeletonBone(height: 20)
            VSkeletonBone(height: 28)
            HStack(spacing: VSpacing.xl) {
                VSkeletonBone(width: 80, height: 14)
                VSkeletonBone(width: 80, height: 14)
            }
        }
        .padding(.bottom, VSpacing.lg)
        .accessibilityHidden(true)
    }

    // MARK: - Error

    private func errorContent(_ message: String) -> some View {
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
        .padding(.bottom, VSpacing.lg)
    }

    // MARK: - Actions

    private func loadReferralCode() async {
        if referralCode == nil {
            isLoading = true
        }
        error = nil
        do {
            referralCode = try await BillingService.shared.getReferralCode()
        } catch {
            if referralCode == nil {
                self.error = "Failed to load referral information."
            }
        }
        isLoading = false
    }

    private func copyToClipboard(_ url: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(url, forType: .string)
        copied = true
        copyResetTask?.cancel()
        copyResetTask = Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard !Task.isCancelled else { return }
            copied = false
        }
    }
}
