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

/// Applies `changes` as one commit, with no implicit animation.
private func immediately(_ changes: () -> Void) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    changes()
    CATransaction.commit()
}

/// Whether a layer has really drawn its first frame. `isReadyForDisplay` can turn true before the frame has reached the
/// screen (a layer that was hidden or transparent has nothing rendered when it becomes visible), so a layer counts as drawn
/// only when it was seen ready at a display refresh and again at two more.
struct AvatarDrawn {
    /// The display refreshes a ready layer is given, after the one that first saw it ready.
    static let refreshes = 2

    /// The display refreshes in a row that saw the layer ready.
    private var seen = 0

    /// A display refresh happened, and the layer was `ready` for display or was not.
    mutating func refresh(ready: Bool) {
        seen = ready ? seen + 1 : 0
    }

    var hasDrawn: Bool {
        seen > Self.refreshes
    }
}

/// Calls its handler at each display refresh, on the main thread, until it is stopped.
private final class RefreshLink: NSObject, @unchecked Sendable {
    private var link: CADisplayLink?
    private let handler: @MainActor () -> Void

    @MainActor
    init(_ handler: @escaping @MainActor () -> Void) {
        self.handler = handler
        super.init()
        let link = CADisplayLink(target: self, selector: #selector(refresh))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    @MainActor @objc private func refresh() {
        handler()
    }

    /// The link holds its target until it is invalidated, so every link that was made must be stopped.
    func stop() {
        Task { @MainActor in
            link?.invalidate()
            link = nil
        }
    }
}

/// One of the two players the clips take turns on, with its layer. A lane's layer is transparent and has no clip while it is
/// cleared. A clip is attached at full opacity, so that the layer renders and can draw, and it is paused at its start: it
/// plays only once the layer has really drawn (`hasDrawn`) and the cover over the lanes has come down.
@MainActor
final class AvatarLane {
    let player = AVPlayer()
    let layer: AVPlayerLayer
    private var drawn = AvatarDrawn()

    init() {
        player.isMuted = true
        player.actionAtItemEnd = .pause
        player.allowsExternalPlayback = false
        player.preventsDisplaySleepDuringVideoPlayback = false
        layer = AVPlayerLayer(player: player)
        layer.videoGravity = .resizeAspectFill
        layer.opacity = 0
    }

    /// Whether the layer has drawn the clip's first frame, and not just reported it ready: `isReadyForDisplay` now, and
    /// two display refreshes after the one that first saw it (`AvatarDrawn`).
    var hasDrawn: Bool {
        layer.isReadyForDisplay && drawn.hasDrawn
    }

    /// Attaches the clip at full opacity, paused at its start.
    func prepare(_ item: AVPlayerItem) {
        drawn = AvatarDrawn()
        immediately { layer.opacity = 1 }
        player.pause()
        player.replaceCurrentItem(with: item)
    }

    func play() {
        player.play()
    }

    /// Takes the clip away: the layer is transparent and has nothing to draw.
    func clear() {
        immediately { layer.opacity = 0 }
        player.pause()
        player.replaceCurrentItem(with: nil)
        drawn = AvatarDrawn()
    }

    /// Returns `true` once the layer has really drawn, `false` when the clip has failed or `timeout` has passed first (a
    /// layer that is on no screen never draws). The display refreshes are counted here.
    func draws(within timeout: Duration) async -> Bool {
        let (refreshes, continuation) = AsyncStream<Void>.makeStream()
        let link = RefreshLink { continuation.yield() }
        let deadline = Task {
            try? await Task.sleep(for: timeout)
            continuation.finish()
        }
        defer {
            link.stop()
            deadline.cancel()
            continuation.finish()
        }
        for await _ in refreshes {
            drawn.refresh(ready: layer.isReadyForDisplay)
            if hasDrawn { return true }
            if player.currentItem?.status == .failed { return false }
        }
        return false
    }
}

/// The picture over both lanes: the pose the next clip starts on while it prepares, and the still at rest. It is opaque and
/// the topmost layer of the avatar, so whatever a lane under it has or has not drawn does not show. It is a layer of the
/// same view as the lanes and not a view of its own, so that it changes in the same commit as they do.
@MainActor
final class AvatarCover {
    let layer = CALayer()
    /// The picture it holds, which shows when it is up.
    private(set) var picture = AvatarPicture.placeholder

    /// The cover is up from the start: nothing has drawn yet.
    init() {
        layer.zPosition = 2
        layer.masksToBounds = true
        layer.contentsGravity = .resizeAspectFill
        layer.minificationFilter = .trilinear
        layer.backgroundColor = Self.navy.cgColor
        hold(.placeholder)
    }

    var isUp: Bool {
        layer.opacity == 1
    }

    /// Changes the picture, whether the cover is up or not.
    func hold(_ picture: AvatarPicture) {
        self.picture = picture
        let image: UIImage
        if case let .still(still) = picture { image = still } else { image = Self.placeholderImage }
        immediately {
            layer.contents = image.cgImage
            layer.contentsScale = image.scale
        }
    }

    func raise() {
        immediately { layer.opacity = 1 }
    }

    func lower() {
        immediately { layer.opacity = 0 }
    }

    private static let navy = UIColor(red: 0.08, green: 0.14, blue: 0.30, alpha: 1)

    /// The navy circle with a person in it that stands in for a missing still.
    private static let placeholderImage: UIImage = {
        let side = AvatarMetrics.diameter
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { context in
            navy.setFill()
            context.fill(CGRect(x: 0, y: 0, width: side, height: side))
            let configuration = UIImage.SymbolConfiguration(pointSize: side * 0.45)
            if let person = UIImage(systemName: "person.fill", withConfiguration: configuration)?
                .withTintColor(UIColor.white.withAlphaComponent(0.9), renderingMode: .alwaysOriginal)
            {
                person.draw(at: CGPoint(x: (side - person.size.width) / 2, y: (side - person.size.height) / 2))
            }
        }
    }()
}

/// Plays one clip at a time, muted, and keeps an undrawn layer from ever being on top of the avatar. The clips have no
/// audio track, and nothing here touches the audio session, so music or a podcast from another app plays on undisturbed.
///
/// - **The cover** is an opaque layer above both lanes (`AvatarCover`). At every change of clip it goes up with the picture
///   of the pose the clip starts on, which matches the clip's first frame and the last frame of the clip before it, so it
///   cannot be seen against either. A layer on the phone can report `isReadyForDisplay` before its frame has reached the
///   screen, and a layer that is hidden or transparent may not render at all, so no layer is ever revealed to find out
///   whether it draws.
/// - **The video** is drawn by two players' layers (`AvatarLane`). A change goes in this order: the cover goes up; the clip
///   that was on screen is cleared under it; the new clip is attached to the other lane at full opacity, rendering, and
///   prerolled paused at its start; once the lane has really drawn (`AvatarLane.hasDrawn`) the cover comes down and the
///   clip plays, in that order. A clip that never draws (a timeout, a failure) leaves the cover up and counts as a clip
///   that cannot play, so an empty layer is never on top.
/// - **At rest** the cover is up with the still, over lanes that have no clip.
@MainActor
final class AvatarPlayer {
    /// How long a clip that cannot play is stood in for: the director waits this long before it goes on.
    static let standIn = Duration.seconds(2)
    /// How long a clip is given to draw. A layer that is not on a screen never does, and the clip then counts as one that
    /// cannot play.
    static let firstFrameTimeout = Duration.seconds(1)

    /// The pose of the picture the cover holds.
    private(set) var pose = AvatarPose.standing

    private let resources: AvatarResources
    private let standIn: Duration
    private let firstFrameTimeout: Duration
    private var task: Task<Void, Never>?
    private var pictures: [AvatarClip: AvatarPicture] = [:]
    private var posePictures: [AvatarPose: AvatarPicture] = [:]
    /// The index in `lanes` of the player whose clip is on screen.
    private var onScreen = 0

    /// Made when the first view asks for them, so that a view built and dropped makes none.
    private(set) lazy var lanes = [AvatarLane(), AvatarLane()]
    private(set) lazy var cover: AvatarCover = {
        let cover = AvatarCover()
        cover.hold(picture(of: .standing))
        return cover
    }()

    init(
        resources: AvatarResources = .bundled,
        standIn: Duration = AvatarPlayer.standIn,
        firstFrameTimeout: Duration = AvatarPlayer.firstFrameTimeout
    ) {
        self.resources = resources
        self.standIn = standIn
        self.firstFrameTimeout = firstFrameTimeout
    }

    /// The layers of the avatar, bottom to top: the two lanes and the cover, for `AvatarPlayerSurface`.
    var layers: [CALayer] {
        lanes.map { $0.layer as CALayer } + [cover.layer]
    }

    /// Plays `clip` and calls `finished` when it ends. A clip whose file is missing or unreadable, or that never draws,
    /// plays nothing: the cover shows the picture of the pose it starts on, and `finished` comes after the stand-in.
    /// Starting a clip ends the one in progress without calling its `finished`.
    func play(_ clip: AvatarClip, finished: @escaping @MainActor () -> Void) {
        task?.cancel()
        // Over whatever is drawn by now goes the pose the clip starts on, before anything else changes.
        pose = clip.startPose
        putCoverUp(clip.startPose)
        task = Task {
            let found = await self.picture(for: clip)
            guard !Task.isCancelled else { return }
            var played = false
            if case let .clip(url) = found {
                played = await run(url)
            }
            guard !Task.isCancelled else { return }
            if !played {
                clearLanes()
                try? await Task.sleep(for: standIn)
                guard !Task.isCancelled else { return }
            }
            pose = clip.endPose
            cover.hold(picture(of: clip.endPose))
            finished()
        }
    }

    /// Puts the cover up with the still and takes the video away under it. A clip that ends on the resting pose and is not
    /// followed by another at once leaves the last frame, the same pose, so the change cannot be seen.
    func rest() {
        pose = .standing
        immediately {
            cover.hold(picture(of: .standing))
            cover.raise()
            clearLanes()
        }
    }

    /// Stops what plays, without calling its `finished`, and shows the still.
    func stop() {
        task?.cancel()
        task = nil
        rest()
    }

    private func putCoverUp(_ pose: AvatarPose) {
        immediately {
            cover.hold(picture(of: pose))
            cover.raise()
        }
    }

    private func clearLanes() {
        lanes.forEach { $0.clear() }
    }

    /// The picture of a pose, which the cover holds.
    private func picture(of pose: AvatarPose) -> AvatarPicture {
        if let known = posePictures[pose] { return known }
        let picture = resources.picture(of: pose)
        posePictures[pose] = picture
        return picture
    }

    private func picture(for clip: AvatarClip) async -> AvatarPicture {
        if let known = pictures[clip] { return known }
        let found = await resources.picture(for: clip)
        pictures[clip] = found
        return found
    }

    /// Plays the file from the start on the lane that is not on screen: the cover is up, the clip before is cleared under
    /// it, the new one prerolls paused, and once its lane has really drawn the cover comes down and it plays. Returns when
    /// it has played to its end or has failed to, and `false` at once if it never drew.
    private func run(_ url: URL) async -> Bool {
        let incoming = lanes[1 - onScreen]
        let outgoing = lanes[onScreen]
        let item = AVPlayerItem(url: url)
        let center = NotificationCenter.default
        // Made before the clip starts, so that an end that comes at once is not missed.
        let ends = center.notifications(named: AVPlayerItem.didPlayToEndTimeNotification, object: item)
        let failures = center.notifications(named: AVPlayerItem.failedToPlayToEndTimeNotification, object: item)

        // The cover is up (`play` did that). Under it the clip before goes, and the new one is attached to the other lane
        // at full opacity, so that its layer renders, paused at its start.
        immediately {
            cover.raise()
            outgoing.clear()
            outgoing.layer.zPosition = 0
            incoming.layer.zPosition = 1
            incoming.prepare(item)
        }
        let drew = await incoming.draws(within: firstFrameTimeout)
        guard !Task.isCancelled else { return true }
        guard drew else {
            // It never drew: the cover stays up, and the lane is cleared under it.
            incoming.clear()
            return false
        }
        // The lane has really drawn: the cover comes down, and then the clip plays.
        immediately { cover.lower() }
        incoming.play()
        onScreen = 1 - onScreen

        await withTaskGroup(of: Void.self) { group in
            group.addTask { for await _ in ends { return } }
            group.addTask { for await _ in failures { return } }
            _ = await group.next()
            group.cancelAll()
        }
        return true
    }
}

/// The player's layers, as a view: the two lanes' video and the cover over them fill the square, and the avatar's circle
/// clips it.
struct AvatarPlayerSurface: UIViewRepresentable {
    let layers: [CALayer]

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
