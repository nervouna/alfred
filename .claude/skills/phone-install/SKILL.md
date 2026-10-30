---
name: phone-install
description: Build the app's Release from origin/main and install it on the owner's iPhone. Covers the signing settings, the throwaway worktree, checking that the deployed server is not older than the app, the build and install with devicectl, what its errors mean, and timing launches on the phone. Use when the user says 装到手机、装 Release、真机安装、手机上看看、装上看看, or after a merge the owner wants to try on the phone. Not for the simulator or its tests (the `app-test` skill), and not for deploying the server (the `deploy` skill).
---

# Installing the app on the phone

The phone runs a Release build signed with the Mac's development certificate; there is no TestFlight. The phone's name, the team id and the SSH alias for the host are in the project memory, not in this public repo; if memory has none, ask the user. Below, `$PHONE` is the phone's name and `$HOST` the host's alias.

## 1. The server first

An app newer than the server can break: one that waited for a stream frame the old server never sent showed an empty chat (#201). Compare what the host runs with `origin/main`:

```bash
git fetch -q origin
DEPLOYED=$(ssh $HOST 'git -C alfred log -1 --format=%H')
git log --oneline "$DEPLOYED"..origin/main -- src
```

If that lists commits, the server has to be deployed first with the `deploy` skill. Deploying needs the owner's go-ahead unless they already gave it for this change: ask, and do not install before the server runs the new build.

## 2. Build

Build from `origin/main` in a throwaway worktree, never from whatever branch the checkout is on. Put the derived data outside the worktree, so the built app outlives it:

```bash
T=$(mktemp -d) && git worktree add --detach "$T/alfred" origin/main
cp ios/Config/Signing.xcconfig "$T/alfred/ios/Config/"
xcodegen generate --spec "$T/alfred/ios/project.yml"
xcodebuild -project "$T/alfred/ios/Alfred.xcodeproj" -scheme Alfred -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath "$T/build" -allowProvisioningUpdates build
```

- Git ignores `ios/Config/Signing.xcconfig`, so a worktree has none: copy it from the main checkout. If the main checkout has none either, copy `Signing.example.xcconfig` to it and fill in the team id and the bundle id from memory. `Base.xcconfig` includes it for every configuration.
- The project is generated, not tracked: `xcodegen generate` runs in the worktree.
- Run the build in the background or with a long timeout. It needs no simulator, so it does not go through `simq`.

## 3. Install

```bash
xcrun devicectl device install app --device "$PHONE" "$T/build/Build/Products/Release-iphoneos/Alfred.app"
```

- `unavailable`, CoreDevice error 4016, means the phone is locked or off the network: ask the owner to unlock it, keep the built `.app`, and run the install again without rebuilding. `xcrun devicectl list devices` shows its state.
- The first install on a phone needs the developer trusted on it (Settings > General > VPN & Device Management). When the provisioning profile expires the app stops opening: build and install again.

## 4. Clean up

```bash
git worktree remove "$T/alfred" && rm -rf "$T"
```

Delete untracked files in the worktree first if `remove` refuses. Tell the owner which commit is now on the phone (`git rev-parse --short origin/main` at build time).

## Timing on the phone

- To time something on the real path, put temporary `print`s in a Release build (never commit them), install it, and launch it with its console: `xcrun devicectl device process launch --console --terminate-existing --device "$PHONE" io.damao.alfred`.
- For a warm start, launch `com.apple.Preferences`, wait, then launch Alfred again without `--terminate-existing`.
