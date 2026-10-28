import SwiftUI

/// The size of the avatar, and how far it reaches below the bar it is centred on.
enum AvatarMetrics {
    static let diameter: CGFloat = 72
    /// A third of the avatar hangs below the bar.
    static let hang: CGFloat = diameter / 3
}

/// Alfred, the butler, in a round frame: a still at rest, short clips now and then while he stands by, and typing while
/// he works on a chat run. Over the clips is a cover with the picture of the pose each one starts on (the still, or the
/// typing pose), which stays up until the clip has drawn; without the clips that picture is what shows, and without it a
/// navy circle with a person.
///
/// It is `diameter` across: 72 pt in the chat's header, bigger on the profile page. It takes touches like any view; the
/// chat's header wraps it in a button.
struct AvatarView: View {
    let state: AvatarState
    var diameter = AvatarMetrics.diameter
    /// The accessibility identifier, which the UI tests tell the chat's avatar and the profile's by.
    var identifier = "chat.header.avatar"
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var conductor = AvatarConductor()

    private var input: AvatarConductor.Input {
        AvatarConductor.Input(state: state, reduceMotion: reduceMotion, isActive: scenePhase == .active)
    }

    var body: some View {
        AvatarPlayerSurface(layers: conductor.player.layers)
            .frame(width: diameter, height: diameter)
            .clipShape(.circle)
            .overlay {
                Circle()
                    .strokeBorder(.white.opacity(0.55), lineWidth: 1)
            }
            .shadow(color: .black.opacity(0.25), radius: 8, y: 3)
            .onAppear { conductor.apply(input) }
            .onChange(of: input) { _, input in conductor.apply(input) }
            // Off the screen nothing plays; coming back starts the cycle again.
            .onDisappear { conductor.halt() }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Alfred")
            .accessibilityValue(state == .working ? "工作中" : "待命")
            .accessibilityIdentifier(identifier)
    }
}

/// Runs a director against the player: waits for each cue, plays its clip, and tells the director when the clip ends.
@MainActor
final class AvatarConductor {
    /// What the conductor runs on.
    struct Input: Equatable {
        let state: AvatarState
        let reduceMotion: Bool
        /// The app is in the foreground.
        let isActive: Bool
    }

    let player: AvatarPlayer
    private let clock: any AvatarClock
    private var director: AvatarDirector
    private var isRunning = false
    private var timer: Task<Void, Never>?

    init(player: AvatarPlayer = AvatarPlayer(), clock: any AvatarClock = SystemAvatarClock()) {
        self.player = player
        self.clock = clock
        director = AvatarDirector(state: .standingBy, random: SystemRandomNumberGenerator(), clock: clock)
    }

    /// Follows the input. While the app is not active nothing plays; when it is active again the cycle starts from the
    /// resting picture, as the first time.
    func apply(_ input: Input) {
        guard input.isActive else {
            halt()
            return
        }
        guard isRunning else {
            isRunning = true
            director = AvatarDirector(state: input.state, reduceMotion: input.reduceMotion, random: SystemRandomNumberGenerator(), clock: clock)
            schedule(director.start())
            return
        }
        var cue = director.update(state: input.state)
        if input.reduceMotion != director.reduceMotion {
            cue = director.update(reduceMotion: input.reduceMotion)
            if input.reduceMotion { stopPlaying() }
        }
        schedule(cue)
    }

    /// Stops the clip and the cycle.
    func halt() {
        isRunning = false
        stopPlaying()
    }

    private func stopPlaying() {
        timer?.cancel()
        timer = nil
        player.stop()
    }

    /// Starts the cue's clip when its time comes, in place of the cue that was waiting.
    private func schedule(_ cue: AvatarDirector.Cue?) {
        guard let cue else { return }
        timer?.cancel()
        timer = nil
        let wait = cue.at - clock.now
        guard wait > 0 else {
            play(cue.clip)
            return
        }
        timer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            guard !Task.isCancelled else { return }
            self?.play(cue.clip)
        }
    }

    private func play(_ clip: AvatarClip) {
        player.play(clip) { [weak self] in self?.clipEnded() }
    }

    private func clipEnded() {
        guard let cue = director.clipEnded() else {
            player.rest()
            return
        }
        // A clip that follows another puts the cover up over its last frame, the pose they share, and takes it down once it
        // has drawn; a pause shows the still, which is the pose every clip before a pause ends on.
        if cue.at > clock.now { player.rest() }
        schedule(cue)
    }
}
