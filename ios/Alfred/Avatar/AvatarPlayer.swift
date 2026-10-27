import AVFoundation
import SwiftUI
import UIKit

/// What the avatar shows. A clip that plays is `clip`; without one it falls back to the still, and without that to a navy
/// circle with a person in it.
enum AvatarPicture: Equatable {
    case clip(URL)
    case still(UIImage)
    case placeholder
}

/// Where the avatar's files are: `<name>.mp4` for each clip (`AvatarClip.resourceName`) and `still.png`, the resting
/// picture. In the app they are bundle resources (`Alfred/Avatar/Clips/`); a file that is not there is not an error.
struct AvatarResources {
    private let folders: [URL]

    /// Looks for the files in these folders, in order.
    init(folders: [URL]) {
        self.folders = folders
    }

    /// The app bundle. XcodeGen copies the files of `Avatar/Clips/` to the bundle's top level; the folder is looked in
    /// too, in case a build keeps it.
    static var bundled: AvatarResources {
        guard let root = Bundle.main.resourceURL else { return AvatarResources(folders: []) }
        return AvatarResources(folders: [root, root.appending(path: "Clips", directoryHint: .isDirectory)])
    }

    /// The file of a clip, when it is there.
    func clipURL(for clip: AvatarClip) -> URL? {
        find(clip.resourceName + ".mp4")
    }

    /// The still, or the placeholder when the file is missing or is not an image.
    func restingPicture() -> AvatarPicture {
        if let url = find("still.png"), let image = UIImage(contentsOfFile: url.path) {
            return .still(image)
        }
        return .placeholder
    }

    /// What to show for a clip: the clip when its file is there and AVFoundation can play it, else the resting picture.
    func picture(for clip: AvatarClip) async -> AvatarPicture {
        if let url = clipURL(for: clip), await Self.plays(url) {
            return .clip(url)
        }
        return restingPicture()
    }

    private func find(_ name: String) -> URL? {
        folders.map { $0.appending(path: name) }.first { FileManager.default.fileExists(atPath: $0.path) }
    }

    /// Whether the file is a video AVFoundation can play. A file it cannot read is `false`, not an error.
    private static func plays(_ url: URL) async -> Bool {
        let asset = AVURLAsset(url: url)
        guard let playable = try? await asset.load(.isPlayable), playable,
              let tracks = try? await asset.loadTracks(withMediaType: .video)
        else { return false }
        return !tracks.isEmpty
    }
}

/// Plays one clip at a time on an `AVPlayer`, muted. The clips have no audio track, and nothing here touches the audio
/// session, so music or a podcast from another app plays on undisturbed. The picture is the player's layer, which
/// `AvatarPlayerSurface` shows over the resting picture.
@MainActor
final class AvatarPlayer {
    /// How long a clip that cannot play is stood in for: the director waits this long before it goes on.
    static let standIn = Duration.seconds(2)

    private let resources: AvatarResources
    private let standIn: Duration
    private var task: Task<Void, Never>?
    private var pictures: [AvatarClip: AvatarPicture] = [:]

    /// Made when the first view asks for it, so that a view built and dropped makes none.
    lazy var player: AVPlayer = {
        let player = AVPlayer()
        player.isMuted = true
        player.actionAtItemEnd = .pause
        player.allowsExternalPlayback = false
        player.preventsDisplaySleepDuringVideoPlayback = false
        return player
    }()

    /// The picture at rest, under the video.
    private(set) lazy var resting = resources.restingPicture()

    init(resources: AvatarResources = .bundled, standIn: Duration = AvatarPlayer.standIn) {
        self.resources = resources
        self.standIn = standIn
    }

    /// Plays `clip` and calls `finished` when it ends. A clip whose file is missing or unreadable plays nothing: the
    /// resting picture shows, and `finished` comes after the stand-in. Starting a clip ends the one in progress without
    /// calling its `finished`.
    func play(_ clip: AvatarClip, finished: @escaping @MainActor () -> Void) {
        task?.cancel()
        task = Task {
            let picture = await self.picture(for: clip)
            guard !Task.isCancelled else { return }
            if case let .clip(url) = picture {
                await run(url)
            } else {
                player.replaceCurrentItem(with: nil)
                try? await Task.sleep(for: standIn)
            }
            guard !Task.isCancelled else { return }
            finished()
        }
    }

    /// Takes the video away so that the resting picture shows. The last frame of a clip that is not followed by another
    /// at once is the resting pose, so the change cannot be seen.
    func rest() {
        player.replaceCurrentItem(with: nil)
    }

    /// Stops what plays, without calling its `finished`.
    func stop() {
        task?.cancel()
        task = nil
        player.pause()
        rest()
    }

    private func picture(for clip: AvatarClip) async -> AvatarPicture {
        if let known = pictures[clip] { return known }
        let found = await resources.picture(for: clip)
        pictures[clip] = found
        return found
    }

    /// Plays the file from the start and returns when it has played to its end or has failed to.
    private func run(_ url: URL) async {
        let item = AVPlayerItem(url: url)
        let center = NotificationCenter.default
        // Made before the clip starts, so that an end that comes at once is not missed.
        let ends = center.notifications(named: AVPlayerItem.didPlayToEndTimeNotification, object: item)
        let failures = center.notifications(named: AVPlayerItem.failedToPlayToEndTimeNotification, object: item)
        player.replaceCurrentItem(with: item)
        player.play()
        await withTaskGroup(of: Void.self) { group in
            group.addTask { for await _ in ends { return } }
            group.addTask { for await _ in failures { return } }
            _ = await group.next()
            group.cancelAll()
        }
    }
}

/// The player's layer, as a view: the video fills the square and the avatar's circle clips it.
struct AvatarPlayerSurface: UIViewRepresentable {
    let player: AVPlayer

    func makeUIView(context: Context) -> PlayerLayerView {
        let view = PlayerLayerView()
        view.backgroundColor = .clear
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        view.playerLayer.videoGravity = .resizeAspectFill
        view.playerLayer.player = player
        return view
    }

    func updateUIView(_ view: PlayerLayerView, context: Context) {}

    final class PlayerLayerView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }

        var playerLayer: AVPlayerLayer {
            guard let layer = layer as? AVPlayerLayer else { preconditionFailure("layerClass is AVPlayerLayer") }
            return layer
        }
    }
}
