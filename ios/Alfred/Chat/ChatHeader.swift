import SwiftUI

/// The chat's own header, in place of the system navigation bar: a round glass button on each side and Alfred's avatar in
/// the middle. The avatar is taller than the bar and hangs over what is below it, so the view that sits under the header
/// keeps `AvatarMetrics.hang` clear at its top.
struct ChatHeader: View {
    /// The height of the bar. The buttons are 44 pt and the avatar's top is 4 pt under the bar's top, so a third of the
    /// avatar is below the bar.
    static let barHeight = AvatarMetrics.diameter - AvatarMetrics.hang + 4
    static let buttonSize: CGFloat = 44

    let state: AvatarState
    /// The 取消配对 item of the menu.
    let unpair: () -> Void

    var body: some View {
        HStack {
            // A slot for a feature that does not exist yet.
            Button {} label: {
                GlassCircle(symbol: "circle.dashed")
            }
            .accessibilityLabel("占位")
            .accessibilityIdentifier("chat.header.leading")
            Spacer(minLength: 0)
            Menu {
                Button("取消配对", systemImage: "iphone.slash", role: .destructive, action: unpair)
            } label: {
                GlassCircle(symbol: "ellipsis")
            }
            .accessibilityLabel("更多")
            .accessibilityIdentifier("chat.header.menu")
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
        .frame(height: Self.barHeight)
        .overlay(alignment: .top) {
            // Taller than the bar: the overlay is not clipped, so the avatar reaches below it.
            AvatarView(state: state)
                .padding(.top, Self.barHeight + AvatarMetrics.hang - AvatarMetrics.diameter)
        }
    }
}

/// The face of a header button: a symbol on the system's glass, in a circle with a 44 pt tap target.
private struct GlassCircle: View {
    let symbol: String

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 18, weight: .medium))
            .foregroundStyle(.primary)
            .frame(width: ChatHeader.buttonSize, height: ChatHeader.buttonSize)
            .glassEffect(.regular.interactive(), in: .circle)
            .contentShape(.circle)
    }
}
