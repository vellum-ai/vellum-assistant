#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Defines the available app actions that can be confirmed via `AppActionSheet`.
enum AppAction: Identifiable {
    case deleteLocal(id: String, name: String)
    case deleteShared(uuid: String, name: String)
    case shareToCloud(id: String, name: String)
    case bundle(id: String, name: String)
    case fork(uuid: String, name: String)

    var id: String {
        switch self {
        case .deleteLocal(let id, _): return "delete-local-\(id)"
        case .deleteShared(let uuid, _): return "delete-shared-\(uuid)"
        case .shareToCloud(let id, _): return "share-\(id)"
        case .bundle(let id, _): return "bundle-\(id)"
        case .fork(let uuid, _): return "fork-\(uuid)"
        }
    }

    var title: String {
        switch self {
        case .deleteLocal: return "Delete App"
        case .deleteShared: return "Delete Shared App"
        case .shareToCloud: return "Share to Cloud"
        case .bundle: return "Bundle for Export"
        case .fork: return "Fork App"
        }
    }

    var description: String {
        switch self {
        case .deleteLocal(_, let name):
            return "Are you sure you want to delete \"\(name)\"? This action cannot be undone."
        case .deleteShared(_, let name):
            return "Are you sure you want to delete \"\(name)\"? This action cannot be undone."
        case .shareToCloud(_, let name):
            return "Share \"\(name)\" to the cloud so others can discover and install it."
        case .bundle(_, let name):
            return "Bundle \"\(name)\" for export. This creates a portable package."
        case .fork(_, let name):
            return "Fork \"\(name)\" into your local apps. You can modify it independently."
        }
    }

    var isDestructive: Bool {
        switch self {
        case .deleteLocal, .deleteShared: return true
        default: return false
        }
    }

    var confirmLabel: String {
        switch self {
        case .deleteLocal, .deleteShared: return "Delete"
        case .shareToCloud: return "Share"
        case .bundle: return "Export"
        case .fork: return "Fork"
        }
    }

    var icon: VIcon {
        switch self {
        case .deleteLocal, .deleteShared: return .trash
        case .shareToCloud: return .upload
        case .bundle: return .package
        case .fork: return .gitBranch
        }
    }
}

/// A reusable confirmation sheet for app operations.
///
/// Shows action description, optional warning for destructive operations,
/// and confirm/cancel buttons. Overlays a progress indicator during async work.
struct AppActionSheet: View {
    let action: AppAction
    let isPerforming: Bool
    let onConfirm: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(spacing: VSpacing.lg) {
            // Icon
            VIconView(action.icon, size: 32)
                .foregroundColor(action.isDestructive ? VColor.error : VColor.accent)

            // Title
            Text(action.title)
                .font(VFont.title)
                .foregroundColor(VColor.textPrimary)

            // Description
            Text(action.description)
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)

            // Warning for destructive ops
            if action.isDestructive {
                HStack(spacing: VSpacing.sm) {
                    VIconView(.triangleAlert, size: 14)
                        .foregroundColor(VColor.error)
                    Text("This action cannot be undone.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.error)
                }
                .padding(VSpacing.sm)
                .background(VColor.error.opacity(0.1))
                .cornerRadius(VRadius.md)
            }

            // Buttons
            HStack(spacing: VSpacing.md) {
                Button {
                    onCancel()
                } label: {
                    Text("Cancel")
                        .font(VFont.bodyBold)
                        .foregroundColor(VColor.textSecondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, VSpacing.sm)
                        .background(VColor.surface)
                        .cornerRadius(VRadius.md)
                }

                Button {
                    onConfirm()
                } label: {
                    Text(action.confirmLabel)
                        .font(VFont.bodyBold)
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, VSpacing.sm)
                        .background(action.isDestructive ? VColor.error : VColor.accent)
                        .cornerRadius(VRadius.md)
                }
            }
        }
        .padding(VSpacing.lg)
        .overlay {
            if isPerforming {
                ZStack {
                    Color.black.opacity(0.3)
                        .cornerRadius(VRadius.lg)
                    ProgressView()
                        .tint(.white)
                }
            }
        }
    }
}
#endif
