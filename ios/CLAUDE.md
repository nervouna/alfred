# iOS client

`README.md` here is the reference (build, run, CI); running the tests and taking screenshots is the `app-test` skill (`.claude/skills/app-test/SKILL.md`). Lessons for writing UI tests are in `AlfredUITests/CLAUDE.md`, for SwiftUI layout in `Alfred/CLAUDE.md`.

## On the phone

- Build the install from `origin/main` in a throwaway `git worktree add --detach <dir> origin/main` with `ios/Config/Signing.xcconfig` copied in (git ignores it), and run `xcodegen generate` there (the project is not tracked); remove the worktree afterwards.
- Before installing, compare the deployed commit (`git -C alfred log -1` on the host) with `git log <deployed>..origin/main -- src`, and deploy first if the server changed: an app newer than the server can show an empty chat (#201).
- `devicectl` reporting the phone `unavailable` (error 4016) means locked or off the network: ask the owner to unlock it, and keep the built `.app`.
- To time the real path, put temporary `print`s in a Release build (never commit them) and run `xcrun devicectl device process launch --console --terminate-existing --device <name> io.damao.alfred`; for a warm start, launch `com.apple.Preferences`, wait, and launch Alfred without `--terminate-existing`.
- An `AVPlayerLayer` with no frame draws nothing on the simulator but black on a phone: check layer transitions on the phone.
