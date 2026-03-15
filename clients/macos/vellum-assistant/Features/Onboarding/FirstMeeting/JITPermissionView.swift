import VellumAssistantShared
import SwiftUI

@MainActor
struct JITPermissionView: View {
    @Bindable var manager: JITPermissionManager

    @State private var showContent = false
    @State private var iconScale: CGFloat = 1.0
    @State private var showTechnicalDetails = false

    var body: some View {
        ZStack {
            // Dimmed backdrop
            VColor.auxBlack.opacity(showContent ? 0.5 : 0)
                .ignoresSafeArea()
                .allowsHitTesting(manager.activePermissionRequest != nil)
                .onTapGesture {
                    dismiss()
                }

            if let request = manager.activePermissionRequest {
                permissionCard(for: request)
                    .transition(
                        .asymmetric(
                            insertion: .opacity.combined(with: .scale(scale: 0.92)),
                            removal: .opacity.combined(with: .scale(scale: 0.95))
                        )
                    )
            }
        }
        .animation(VAnimation.panel, value: manager.activePermissionRequest != nil)
        .onAppear {
            if manager.activePermissionRequest != nil {
                showContent = false
                showTechnicalDetails = false
                iconScale = 1.0
                withAnimation(.easeOut(duration: 0.4).delay(0.1)) {
                    showContent = true
                }
                startIconBreathing()
            }
        }
        .onChange(of: manager.activePermissionRequest) { _, newValue in
            if newValue != nil {
                showContent = false
                showTechnicalDetails = false
                iconScale = 1.0
                withAnimation(.easeOut(duration: 0.4).delay(0.1)) {
                    showContent = true
                }
                startIconBreathing()
            } else {
                withAnimation(VAnimation.fast) {
                    showContent = false
                    showTechnicalDetails = false
                }
            }
        }
    }

    // MARK: - Permission Card

    private func permissionCard(for request: JITPermissionManager.JITPermissionType) -> some View {
        VStack(spacing: VSpacing.xl) {
            // Icon with breathing glow
            ZStack {
                Circle()
                    .fill(
                        RadialGradient(
                            colors: [VColor.primaryBase.opacity(0.3), VColor.primaryBase.opacity(0.0)],
                            center: .center, startRadius: 0, endRadius: 40
                        )
                    )
                    .frame(width: 80, height: 80)
                    .scaleEffect(iconScale)
                VIconView(SFSymbolMapping.icon(forSFSymbol: request.icon, fallback: .puzzle), size: 32)
                    .foregroundColor(VColor.primaryBase)
                    .scaleEffect(iconScale)
            }
            .opacity(showContent ? 1 : 0)
            .offset(y: showContent ? 0 : 8)

            // Non-technical question (bold) + supporting message
            VStack(spacing: VSpacing.sm) {
                Text(request.title)
                    .font(VFont.onboardingTitle)
                    .foregroundColor(VColor.contentDefault)
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)

                Text(request.message)
                    .font(VFont.body)
                    .foregroundColor(VColor.contentSecondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 320)
                    .textSelection(.enabled)
            }
            .opacity(showContent ? 1 : 0)
            .offset(y: showContent ? 0 : 6)

            // Collapsed technical details accordion
            VStack(alignment: .leading, spacing: 0) {
                Button(action: {
                    withAnimation(VAnimation.standard) {
                        showTechnicalDetails.toggle()
                    }
                }) {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.chevronRight, size: 9)
                            .foregroundColor(VColor.primaryBase)
                            .rotationEffect(.degrees(showTechnicalDetails ? 90 : 0))
                        Text("Technical details")
                            .font(VFont.captionMedium)
                            .foregroundColor(VColor.primaryBase)
                    }
                }
                .buttonStyle(.plain)

                if showTechnicalDetails {
                    VStack(alignment: .leading, spacing: VSpacing.sm) {
                        Text(request.explanation)
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)

                        Text(request.technicalDetails)
                            .font(VFont.small)
                            .foregroundColor(VColor.contentTertiary)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                    .padding(.top, VSpacing.sm)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .clipped()
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(VSpacing.md)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(VColor.surfaceBase.opacity(0.3))
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.borderBase.opacity(0.4), lineWidth: 1)
                    )
            )
            .opacity(showContent ? 1 : 0)

            // Action buttons — "Allow" comes first; intentional design
            // choice to make the positive action the default leftmost button.
            HStack(spacing: VSpacing.sm) {
                permissionButton("Allow", isPrimary: false) {
                    manager.grantActivePermission()
                }
                permissionButton("Don't Allow", isPrimary: false) {
                    dismiss()
                }
                permissionButton("Always Allow", isPrimary: true) {
                    manager.grantActivePermission(always: true)
                }
            }
            .opacity(showContent ? 1 : 0)
        }
        .padding(.horizontal, VSpacing.xxl)
        .padding(.vertical, VSpacing.xxxl)
        .frame(maxWidth: 420)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(.ultraThinMaterial)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .fill(Meadow.panelBackground)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(Meadow.panelBorder, lineWidth: 1)
                )
        )
        .shadow(color: VColor.auxBlack.opacity(0.5), radius: 32, y: 16)
    }

    // MARK: - Helpers

    @ViewBuilder
    private func permissionButton(_ title: String, isPrimary: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(VFont.captionMedium)
                .foregroundColor(isPrimary ? VColor.auxWhite : VColor.contentDefault.opacity(0.85))
                .frame(maxWidth: .infinity)
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, VSpacing.sm + VSpacing.xxs)
                .background(isPrimary ? AnyShapeStyle(VColor.primaryBase) : AnyShapeStyle(Color.clear))
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(isPrimary ? Color.clear : VColor.contentDefault.opacity(0.2), lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .frame(maxWidth: .infinity)
    }

    private func dismiss() {
        manager.dismissActivePermission()
    }

    private func startIconBreathing() {
        withAnimation(
            .easeInOut(duration: 2.0)
            .repeatForever(autoreverses: true)
        ) {
            iconScale = 1.08
        }
    }
}

// MARK: - Preview

#if DEBUG

private struct JITPermissionViewPreviewWrapper: View {
    let permission: JITPermissionManager.JITPermissionType
    @State private var manager: JITPermissionManager

    init(permission: JITPermissionManager.JITPermissionType) {
        self.permission = permission
        let m = JITPermissionManager()
        m.isActive = true
        m.activePermissionRequest = permission
        _manager = State(initialValue: m)
    }

    var body: some View {
        ZStack {
            VColor.surfaceOverlay.ignoresSafeArea()
            JITPermissionView(manager: manager)
        }
    }
}
#endif
