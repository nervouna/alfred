import SwiftUI
import UIKit

/// What the system says about its own navigation bar, which the chat's header stands in for.
@MainActor
enum SystemBar {
    /// The height of the inline navigation bar on this device and system, below the status bar and the Dynamic Island, as
    /// UIKit reports it for a bar of its own. The header is not given a height of ours, so that it follows the system's.
    static let inlineHeight: CGFloat = UINavigationBar().sizeThatFits(.zero).height
}

/// The chat's own bar, in place of the system navigation bar: a round glass button on each side, and nothing else. It is
/// exactly as tall as the system's inline bar (`SystemBar.inlineHeight`), so its hit area and the soft edge effect the
/// list draws under it end where a system bar's would.
///
/// Alfred's avatar is not part of it. The avatar is taller than the bar and hangs over what is below it, so it is drawn by
/// `ChatHeaderOverlay`, over the chat, and the view under the bar keeps `AvatarMetrics.hang` clear at its top for it.
struct ChatHeader: View {
    /// The height of the bar.
    static var barHeight: CGFloat { SystemBar.inlineHeight }
    static let buttonSize: CGFloat = 44

    /// How far the avatar's top edge is below the bar's top edge, which is the top of the safe area (the bar sits under
    /// the status bar and the Dynamic Island): the bar's height less what the avatar has above the bar's bottom edge, its
    /// diameter less the `AvatarMetrics.hang` of it that is below.
    static var avatarOffset: CGFloat {
        barHeight - (AvatarMetrics.diameter - AvatarMetrics.hang)
    }

    /// Whether a chat run is going: the commands that start or switch a session are held off until it has ended.
    let isChatRunning: Bool
    /// Sends a command's text as the owner's message.
    let send: (ChatCommand) -> Void
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
                ForEach(Array(ChatCommand.menu.enumerated()), id: \.offset) { _, group in
                    Section {
                        if group.allSatisfy(\.isModel) {
                            Menu("模型", systemImage: "cpu") {
                                ForEach(group, id: \.self, content: item)
                            }
                        } else {
                            ForEach(group, id: \.self, content: item)
                        }
                    }
                }
                Divider()
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
        .background {
            // The bar as one element of its own, for the UI tests: the buttons stay what they are, and this one has the
            // bar's frame.
            Color.clear
                .accessibilityElement()
                .accessibilityIdentifier("chat.header.bar")
        }
    }

    /// A menu item for a command. One that needs an idle chat is off while a run is going.
    private func item(_ command: ChatCommand) -> some View {
        Button(command.title, systemImage: command.symbol) { send(command) }
            .disabled(command.needsIdleChat && isChatRunning)
    }
}

/// Alfred's avatar over the top of the chat, centred, with its lower third below the bar's bottom edge; under it, while
/// the stream is not connected, a capsule that says so. It is a layer of the chat above the bar and the list, not part of
/// the bar.
///
/// The avatar is a button that opens Alfred's profile, and it is all of the overlay that takes touches: the capsule does
/// not, and neither does the space around them. A drag that starts on the avatar does not scroll the list under it any
/// more, since the touch is the button's.
struct ChatHeaderOverlay: View {
    let state: AvatarState
    let isConnected: Bool
    /// Opens Alfred's profile.
    let openProfile: () -> Void

    var body: some View {
        // An overlay is laid out inside the safe area, so its top is the bar's top edge: the avatar is placed from there.
        VStack(spacing: 6) {
            Button(action: openProfile) {
                AvatarView(state: state)
                    .contentShape(.circle)
            }
            .buttonStyle(.plain)
            if !isConnected {
                ConnectingCapsule()
                    .allowsHitTesting(false)
            }
        }
        .frame(maxWidth: .infinity, alignment: .top)
        .padding(.top, ChatHeader.avatarOffset)
    }
}

/// Says the stream is not connected: the text and the spinner on the bar's material, in a capsule.
private struct ConnectingCapsule: View {
    var body: some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
            Text("连接中…")
                .font(.footnote)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.bar, in: .capsule)
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
