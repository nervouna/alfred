# SwiftUI lessons

- A `safeAreaBar` hosts only what lies in its frame (a control pushed out with `offset` draws but takes no taps), and its scroll edge effect covers everything it draws, overflow included. Content that hangs below a bar (the chat's avatar) is an overlay of the screen. A control that scrolls with the content and then pins has two instances, one in the content and one in the bar (`ProfileView`); the bar's room is part of `ScrollGeometry.contentInsets` while it shows.
- The profile page is pushed with `navigationDestination(isPresented:)`, so a `NavigationLink(value:)` inside it rebuilds the page: use a destination closure, and `navigationDestination(item:)` for forms.
- `.searchable` on the memory list hid its field and moved the avatar; `.searchToolbarBehavior(.minimize)` does not move the content.
- Hang a delete confirmation on the `List`, not the row: the swipe action takes the row away and the dialog never opens (#215).
- A list's first section needs `listSectionMargins([.top, .horizontal], 0)` to line up with a scroll view's content.
- `.buttonStyle(.glass)` pads its label by 7 pt per side: a 44 pt circle takes a 30 pt label. A `Menu` draws its label in the tint and ignores `foregroundStyle`: use `.tint(.secondary)`.
- `defaultScrollAnchor(.bottom)` does not keep the end in view when the container shrinks (the keyboard): scroll there on a container change (`MessageList`).
- `onChange` of a derived value can miss two model changes between draws (a pending message and its echo): watch the model with `Observations` when every change counts.
- Observation tells observers before a change (`willSet`), and SwiftUI can update views right then, inside the mutation: a view reading the property gets the old value and misses the write that follows. That dropped the reply right after its echo (#218), so `AppModel.timeline` is written to ignored storage first and an observed version bumped after (`changeTimeline`). To catch such a race, use an in-memory ring buffer and `Thread.callStackSymbols` in the view body.
- An `AVPlayerLayer` with no frame draws nothing on the simulator but black on a phone: check layer transitions on the phone.
