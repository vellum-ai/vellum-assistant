#if DEBUG
import SwiftUI

struct IconsGallerySection: View {
    @State private var searchText = ""

    private var filteredIcons: [VIcon] {
        if searchText.isEmpty {
            return VIcon.allCases
        }
        let query = searchText.lowercased()
        return VIcon.allCases.filter { $0.rawValue.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            GallerySectionHeader(
                title: "Icons",
                description: "Vendored Lucide icon tokens. Use VIconView(.iconName) for rendering."
            )

            VSearchBar(placeholder: "Filter icons...", text: $searchText)

            Text("\(filteredIcons.count) icons")
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)

            VCard {
                LazyVGrid(
                    columns: Array(repeating: GridItem(.flexible(), spacing: VSpacing.md), count: 6),
                    spacing: VSpacing.lg
                ) {
                    ForEach(filteredIcons, id: \.rawValue) { icon in
                        VStack(spacing: VSpacing.xs) {
                            VIconView(icon, size: 20)
                                .foregroundColor(VColor.contentDefault)
                                .frame(width: 32, height: 32)
                            Text(icon.rawValue.replacingOccurrences(of: "lucide-", with: ""))
                                .font(VFont.small)
                                .foregroundColor(VColor.contentTertiary)
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }
                        .frame(maxWidth: .infinity)
                    }
                }
            }
        }
    }
}

#endif
