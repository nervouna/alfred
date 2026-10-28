import XCTest

/// Has Alfred put a question to the owner and answers it from the chat: by tapping an option, by typing, and by
/// stopping the run. It runs against a running `scripts/app-dev.ts`, whose pairing comes from the environment
/// variable `ALFRED_PAIRING` (pass `TEST_RUNNER_ALFRED_PAIRING` to xcodebuild); without it the tests skip themselves,
/// so CI and plain test runs need no stack. Each test runs the model (haiku) for one task, a fraction of a cent.
final class QuestionsUITests: XCTestCase {
    /// How long to wait for the app or for the server, which answers a command without a model.
    private let patience: TimeInterval = 30
    /// How long to wait for what needs a model call.
    private let modelPatience: TimeInterval = 120

    private static let prompt = "请用 AskUserQuestion 工具问我喜欢红色还是蓝色（两个选项），等我回答后只回复我选的颜色。"

    /// What was on screen when the test started: the stream replays what an earlier run left on the stack.
    private struct Known {
        let cards: [String]
        let messages: [String]
    }

    @MainActor
    func testAnswerAQuestionByTappingAnOption() throws {
        let (app, known) = try launchPaired()
        send(Self.prompt, in: app)

        // A card for the question appears where it was asked, with an option for each color.
        let card = newCard(known, in: app)
        XCTAssertTrue(card.waitForExistence(timeout: modelPatience), "no question card\n\(app.debugDescription)")
        let red = option(containing: "红色", in: card)
        let blue = option(containing: "蓝色", in: card)
        XCTAssertTrue(blue.waitForExistence(timeout: patience), "no option 蓝色\n\(app.debugDescription)")
        XCTAssertTrue(red.exists, "no option 红色")

        // A tap answers at once. A model that asked for more than one question gets its answer submitted.
        blue.tap()
        let submit = card.buttons["question.submit"]
        if submit.waitForExistence(timeout: 2) {
            submit.tap()
        }

        // The card keeps the answer, and the options are gone.
        let answer = card.staticTexts.matching(identifier: "question.answered").firstMatch
        XCTAssertTrue(answer.waitForExistence(timeout: patience), "the card does not show the answer\n\(app.debugDescription)")
        XCTAssertTrue(answer.label.contains("蓝"), answer.label)
        XCTAssertTrue(blue.waitForNonExistence(timeout: patience), "the options should go once the question is answered")

        // The run goes on with the answer.
        let reply = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'message.out.' AND NOT (identifier IN %@) AND label CONTAINS '蓝'", known.messages))
            .firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: modelPatience), "no reply naming the color\n\(app.debugDescription)")
    }

    /// Typing in the composer answers an open question as free text, and the card shows what was typed.
    @MainActor
    func testTypingInTheComposerAnswersTheQuestion() throws {
        let (app, known) = try launchPaired()
        send(Self.prompt, in: app)
        let card = newCard(known, in: app)
        XCTAssertTrue(card.waitForExistence(timeout: modelPatience), "no question card\n\(app.debugDescription)")
        XCTAssertTrue(option(containing: "蓝色", in: card).waitForExistence(timeout: patience))

        send("都不喜欢，我要绿色", in: app)

        let answer = card.staticTexts.matching(identifier: "question.answered").firstMatch
        XCTAssertTrue(answer.waitForExistence(timeout: patience), "the card does not show the typed answer\n\(app.debugDescription)")
        XCTAssertTrue(answer.label.contains("绿色"), answer.label)
    }

    /// Stopping the run cancels its open question.
    @MainActor
    func testStoppingTheRunMarksTheQuestionCancelled() throws {
        let (app, known) = try launchPaired()
        send(Self.prompt, in: app)
        let card = newCard(known, in: app)
        XCTAssertTrue(card.waitForExistence(timeout: modelPatience), "no question card\n\(app.debugDescription)")
        XCTAssertTrue(option(containing: "蓝色", in: card).waitForExistence(timeout: patience))

        let stop = app.buttons["停止"]
        XCTAssertTrue(stop.waitForExistence(timeout: patience), "no stop button while the run waits")
        stop.tap()

        let cancelled = card.staticTexts["已取消"]
        XCTAssertTrue(cancelled.waitForExistence(timeout: patience), "the card does not say 已取消\n\(app.debugDescription)")
        XCTAssertFalse(option(containing: "蓝色", in: card).exists, "a cancelled question has no options to tap")
        XCTAssertTrue(app.buttons["停止"].waitForNonExistence(timeout: patience), "the run should have ended")
    }

    // MARK: Driving the app

    /// Leaves the app on the pairing screen: a paired app unpairs through the menu, and one whose device the
    /// server no longer knows (the stack was restarted) pairs again from the failure screen.
    @MainActor
    private func unpairIfPaired(_ app: XCUIApplication) {
        let paste = app.buttons["粘贴配对信息"]
        let tab = app.tabBars.buttons["对话"]
        let repair = app.buttons["重新配对"]
        let deadline = Date().addingTimeInterval(patience)
        while Date() < deadline, !paste.exists, !tab.exists, !repair.exists {
            usleep(100_000)
        }
        if repair.exists {
            repair.tap()
        } else if tab.exists {
            let more = app.buttons["更多"]
            XCTAssertTrue(more.waitForExistence(timeout: patience), "no menu button\n\(app.debugDescription)")
            more.tap()
            let item = app.buttons["取消配对"]
            XCTAssertTrue(item.waitForExistence(timeout: patience), "no 取消配对 in the menu\n\(app.debugDescription)")
            item.tap()
            // The confirmation is a sheet with a button of the same name. Wait for that one: a tap on the first
            // button of that name can land on the menu item while it is still fading out.
            let confirm = app.sheets.buttons["取消配对"]
            XCTAssertTrue(confirm.waitForExistence(timeout: patience), "no confirmation sheet\n\(app.debugDescription)")
            confirm.tap()
        }
        XCTAssertTrue(paste.waitForExistence(timeout: patience), "the app did not return to pairing\n\(app.debugDescription)")
    }

    /// Launches the app, pairs it with the stack and waits for the replay of old events to be over.
    @MainActor
    private func launchPaired() throws -> (XCUIApplication, Known) {
        guard let pairing = ProcessInfo.processInfo.environment["ALFRED_PAIRING"], !pairing.isEmpty else {
            throw XCTSkip("ALFRED_PAIRING is not set: start scripts/app-dev.ts and pass its pairing to run this test")
        }
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        unpairIfPaired(app)
        UIPasteboard.general.string = pairing
        app.buttons["粘贴配对信息"].tap()
        XCTAssertTrue(composer(in: app).waitForExistence(timeout: patience), "the chat did not appear\n\(app.debugDescription)")
        XCTAssertTrue(app.staticTexts["连接中…"].waitForNonExistence(timeout: patience), "the stream never connected")
        waitUntilStable { cardIds(in: app).count + messageIds(in: app).count }
        return (app, Known(cards: cardIds(in: app), messages: messageIds(in: app)))
    }

    /// The question card that was not on screen when the test started.
    @MainActor
    private func newCard(_ known: Known, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'question.card.' AND NOT (identifier IN %@)", known.cards))
            .firstMatch
    }

    @MainActor
    private func composer(in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: "composer").firstMatch
    }

    @MainActor
    private func send(_ text: String, in app: XCUIApplication) {
        let field = composer(in: app)
        field.tap()
        field.typeText(text)
        app.buttons["发送"].tap()
    }

    /// The option of a question card whose label contains `fragment`.
    @MainActor
    private func option(containing fragment: String, in card: XCUIElement) -> XCUIElement {
        card.buttons.matching(NSPredicate(format: "identifier == 'question.option' AND label CONTAINS %@", fragment)).firstMatch
    }

    /// The identifiers of the question cards on screen: `question.card.<id>`.
    @MainActor
    private func cardIds(in app: XCUIApplication) -> [String] {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'question.card.'"))
            .allElementsBoundByIndex.map(\.identifier)
    }

    /// The identifiers of the stored messages on screen: `message.in.<id>` or `message.out.<id>`.
    @MainActor
    private func messageIds(in app: XCUIApplication) -> [String] {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'message.'"))
            .allElementsBoundByIndex.map(\.identifier)
            .filter { $0.hasPrefix("message.in.") || $0.hasPrefix("message.out.") }
    }

    /// Returns once `value` has stayed the same for a second, which is when the replay of old events is over.
    @MainActor
    private func waitUntilStable(_ value: () -> Int) {
        var last = value()
        var steady = 0
        let deadline = Date().addingTimeInterval(patience)
        while steady < 4, Date() < deadline {
            usleep(250_000)
            let now = value()
            steady = now == last ? steady + 1 : 0
            last = now
        }
    }
}
