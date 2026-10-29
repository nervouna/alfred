# Writing UI tests

How to run them is in `../CLAUDE.md` and `../README.md`.

- XCUITest's "hittable" lies both ways. A control under the keyboard, in a resizing sheet, or under the glass navigation or tab bar counts as hittable (the tap lands on the bar); the chat's avatar can count as not hittable while a tap works. Tap once the frame holds still (`tapWhenSettled` in `IdeasUITests`), scroll rows between the bars first (`scrollBetweenBars`), check the top of a list by frames, not hittability (`scrollToTop` in `MemoryUITests`), and let the page a tap opens be the check.
- A view combined with `.accessibilityElement(children: .combine)` is not a `staticText` (a chat bubble can be `other`): look it up by identifier in `app.descendants(matching: .any)`.
- A `confirmationDialog` opened from a toolbar button is a popover with no cancel: tap `PopoverDismissRegion`. The memory list's delete confirmation is in `app.alerts`.
- Clear a text view with `.delete` back from the end: `.forwardDelete` is typed as U+F728.
- Drags lose their first points to the touch slop and carry on after lift: `press(forDuration:thenDragTo:withVelocity: .slow, thenHoldForDuration:)`, then look again (`drag(_:to:in:)` in `ProfileUITests`).
- A control placed in a scroll view's content and in a list's first row lands a third of a point apart: compare with a one-point tolerance (`samePlace`).
- When a test fails and the `app-dev` log shows the answer was sent, find which side lacks it: expose the model's counts as the `accessibilityValue` of a clear 4 pt probe overlaid on `ChatView`, and write `app.screenshot().pngRepresentation` to an absolute host path. Do not trace with `NSLog`: its synchronous writes hid a race (#218), and so did `Logger` in the update path; use an in-memory buffer.
