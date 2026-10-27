import AVFoundation
import SwiftUI
import UIKit

/// What the avatar shows. A clip that plays is `clip`; without one it falls back to the picture of the pose the clip
/// starts on (`still`, an image: the still or the typing pose), and without that to a navy circle with a person in it.
enum AvatarPicture: Equatable {
    case clip(URL)
    case still(UIImage)
    case placeholder
}

/// Where the avatar's files are: `<name>.mp4` for each clip (`AvatarClip.resourceName`), `still.png`, the resting
/// picture, and `typing.png`, the typing pose. In the app they are bundle resources (`Alfred/Avatar/Clips/`); a file that
/// is not there is not an error.
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
        picture(of: .standing)
    }

    /// The picture of a pose: `still.png` for standing and `typing.png` for typing. A typing picture that is missing or
    /// is not an image is the still, and a still that is missing or is not an image is the placeholder.
    func picture(of pose: AvatarPose) -> AvatarPicture {
        switch pose {
        case .standing: image(named: "still.png").map(AvatarPicture.still) ?? .placeholder
        case .typing: image(named: "typing.png").map(AvatarPicture.still) ?? picture(of: .standing)
        }
    }

    /// What to show for a clip: the clip when its file is there and AVFoundation can play it, else the picture of the
    /// pose it starts on.
    func picture(for clip: AvatarClip) async -> AvatarPicture {
        if let url = clipURL(for: clip), await Self.plays(url) {
            return .clip(url)
        }
        return picture(of: clip.startPose)
    }

    private func image(named name: String) -> UIImage? {
        find(name).flatMap { UIImage(contentsOfFile: $0.path) }
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

/// One of the two players the clips take turns on. A player that is given a new item draws nothing until the item's first
/// frame is ready, so a clip that follows another one plays on the other player, and the first one keeps its last frame
/// on screen until then. A lane's layer is on screen only while it has a frame: it is transparent from the start and goes
/// on screen when its layer says the first frame is ready, and it leaves the screen when the lane is cleared. A layer that
/// is on screen without a frame would cover the picture under the video with nothing.
@MainActor
final class AvatarLane {
    let player = AVPlayer()
    let layer: AVPlayerLayer

    init() {
        player.isMuted = true
        player.actionAtItemEnd = .pause
        player.allowsExternalPlayback = false
        player.preventsDisplaySleepDuringVideoPlayback = false
        layer = AVPlayerLayer(player: player)
        layer.videoGravity = .resizeAspectFill
        layer.opacity = 0
    }

    /// Puts the layer on screen, once it has a frame.
    func show() {
        setOnScreen(true)
    }

    /// Takes the clip away: the layer is off screen and draws nothing.
    func clear() {
        setOnScreen(false)
        player.pause()
        player.replaceCurrentItem(with: nil)
    }

    /// At once, not by the fade a layer's opacity would otherwise animate with.
    private func setOnScreen(_ onScreen: Bool) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.opacity = onScreen ? 1 : 0
        CATransaction.commit()
    }
}

/// Plays one clip at a time, muted, and keeps what is under it. The clips have no audio track, and nothing here touches
/// the audio session, so music or a podcast from another app plays on undisturbed.
///
/// - **The video** is drawn by two players' layers, one over the other (`AvatarPlayerSurface` puts them in the view). A
///   clip plays on the player that is not on screen, with its layer above the other's but off screen (transparent), so the
///   clip before it, or the picture under the video, stays visible. Only once `isReadyForDisplay` says that the first frame
///   is there does the layer go on screen, and in the same commit the old clip is taken away. A lane is on screen only with
///   a frame: at no moment is there an empty layer over the picture, and at no moment neither a frame nor the picture.
/// - **The picture under the video** is the pose the clip starts on while it plays (`still.png`, or `typing.png`), the
///   pose it ended on when it has ended, and the still at rest. It shows only where the video does not: before the first
///   clip, after a rest, and for a clip that cannot play. `AvatarClip.startPose` and `endPose` say which pose is which.
@MainActor
@Observable
final class AvatarPlayer {
    /// How long a clip that cannot play is stood in for: the director waits this long before it goes on.
    static let standIn = Duration.seconds(2)
    /// How long a clip is given to draw its first frame. A layer that is not on a screen never does, and the clip then
    /// takes the screen without having drawn (the one case in which a lane is on screen with no frame).
    static let firstFrameTimeout = Duration.seconds(1)

    /// The pose of the picture under the video.
    private(set) var pose = AvatarPose.standing

    @ObservationIgnored private let resources: AvatarResources
    @ObservationIgnored private let standIn: Duration
    @ObservationIgnored private let firstFrameTimeout: Duration
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var pictures: [AvatarClip: AvatarPicture] = [:]
    @ObservationIgnored private var posePictures: [AvatarPose: AvatarPicture] = [:]
    /// The index in `lanes` of the player whose clip is on screen.
    @ObservationIgnored private var onScreen = 0

    /// Made when the first view asks for them, so that a view built and dropped makes none.
    @ObservationIgnored private(set) lazy var lanes = [AvatarLane(), AvatarLane()]

    init(
        resources: AvatarResources = .bundled,
        standIn: Duration = AvatarPlayer.standIn,
        firstFrameTimeout: Duration = AvatarPlayer.firstFrameTimeout
    ) {
        self.resources = resources
        self.standIn = standIn
        self.firstFrameTimeout = firstFrameTimeout
    }

    /// The two layers the video is drawn on, for `AvatarPlayerSurface`.
    var layers: [AVPlayerLayer] {
        lanes.map(\.layer)
    }

    /// The picture under the video.
    var underlay: AvatarPicture {
        let pose = self.pose
        if let known = posePictures[pose] { return known }
        let picture = resources.picture(of: pose)
        posePictures[pose] = picture
        return picture
    }

    /// Plays `clip` and calls `finished` when it ends. A clip whose file is missing or unreadable plays nothing: the
    /// picture of the pose it starts on shows, and `finished` comes after the stand-in. Starting a clip ends the one in
    /// progress without calling its `finished`.
    func play(_ clip: AvatarClip, finished: @escaping @MainActor () -> Void) {
        task?.cancel()
        // Under the clip is the pose it starts on, whatever is drawn over it by now.
        pose = clip.startPose
        task = Task {
            let picture = await self.picture(for: clip)
            guard !Task.isCancelled else { return }
            if case let .clip(url) = picture {
                await run(url)
            } else {
                clearLanes()
                try? await Task.sleep(for: standIn)
            }
            guard !Task.isCancelled else { return }
            pose = clip.endPose
            finished()
        }
    }

    /// Takes the video away and shows the still. A clip that ends on the resting pose and is not followed by another at
    /// once leaves the last frame, the same pose, so the change cannot be seen.
    func rest() {
        clearLanes()
        pose = .standing
    }

    /// Stops what plays, without calling its `finished`, and shows the still.
    func stop() {
        task?.cancel()
        task = nil
        rest()
    }

    private func clearLanes() {
        lanes.forEach { $0.clear() }
    }

    private func picture(for clip: AvatarClip) async -> AvatarPicture {
        if let known = pictures[clip] { return known }
        let found = await resources.picture(for: clip)
        pictures[clip] = found
        return found
    }

    /// Plays the file from the start on the player that is not on screen, puts it on screen once it has drawn its first
    /// frame (until then whatever is under it shows), and returns when it has played to its end or has failed to.
    private func run(_ url: URL) async {
        let incoming = lanes[1 - onScreen]
        let outgoing = lanes[onScreen]
        let item = AVPlayerItem(url: url)
        let center = NotificationCenter.default
        // Made before the clip starts, so that an end that comes at once is not missed.
        let ends = center.notifications(named: AVPlayerItem.didPlayToEndTimeNotification, object: item)
        let failures = center.notifications(named: AVPlayerItem.failedToPlayToEndTimeNotification, object: item)

        // The new clip's layer is above the old one but not on screen, so the old clip's last frame, or the picture under
        // the video, shows until the new clip's first frame is ready.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        incoming.layer.zPosition = 1
        outgoing.layer.zPosition = 0
        CATransaction.commit()
        incoming.player.replaceCurrentItem(with: item)
        incoming.player.play()
        await firstFrame(of: incoming.layer)
        guard !Task.isCancelled else { return }
        // The new clip has a frame: it goes on screen, and the old one goes, in the same commit.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        incoming.show()
        outgoing.clear()
        CATransaction.commit()
        onScreen = 1 - onScreen

        await withTaskGroup(of: Void.self) { group in
            group.addTask { for await _ in ends { return } }
            group.addTask { for await _ in failures { return } }
            _ = await group.next()
            group.cancelAll()
        }
    }

    /// Returns once the layer has a frame to show, or when `firstFrameTimeout` has passed.
    private func firstFrame(of layer: AVPlayerLayer) async {
        let frames = AsyncStream<Void> { continuation in
            let observation = FrameObservation(layer) { continuation.yield() }
            continuation.onTermination = { _ in observation.stop() }
        }
        let timeout = firstFrameTimeout
        await withTaskGroup(of: Void.self) { group in
            group.addTask { for await _ in frames { return } }
            group.addTask { try? await Task.sleep(for: timeout) }
            _ = await group.next()
            group.cancelAll()
        }
    }
}

/// Calls `ready` when a layer's `isReadyForDisplay` is true: at once if it is already.
private final class FrameObservation: @unchecked Sendable {
    private var observation: NSKeyValueObservation?

    @MainActor
    init(_ layer: AVPlayerLayer, ready: @escaping @Sendable () -> Void) {
        observation = layer.observe(\.isReadyForDisplay, options: [.initial, .new]) { _, change in
            if change.newValue == true { ready() }
        }
    }

    func stop() {
        observation?.invalidate()
        observation = nil
    }
}

/// The player's two layers, as a view: the video fills the square and the avatar's circle clips it.
struct AvatarPlayerSurface: UIViewRepresentable {
    let layers: [AVPlayerLayer]

    func makeUIView(context: Context) -> LayerHostView {
        let view = LayerHostView()
        view.backgroundColor = .clear
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        layers.forEach { view.layer.addSublayer($0) }
        return view
    }

    func updateUIView(_ view: LayerHostView, context: Context) {}

    final class LayerHostView: UIView {
        override func layoutSubviews() {
            super.layoutSubviews()
            // The layers follow the view's size at once, not by an animation.
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            layer.sublayers?.forEach { $0.frame = bounds }
            CATransaction.commit()
        }
    }
}
