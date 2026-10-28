import AlfredKit
import XCTest

@testable import Alfred

/// The owner's edit of ALFRED.md, apart from the screen that shows it.
final class RulesDraftTests: XCTestCase {
    private func draft(_ text: String = "# 规则\n", version: String = String(repeating: "a", count: 64), maxBytes: Int = 8192) throws -> RulesDraft {
        RulesDraft(try TestData.rules(text: text, version: version, maxBytes: maxBytes))
    }

    // MARK: What it holds

    func testADraftStartsAsTheRulesWithNothingChanged() throws {
        let draft = try draft("# 规则\n", version: String(repeating: "b", count: 64), maxBytes: 100)
        XCTAssertEqual(draft.text, "# 规则\n")
        XCTAssertEqual(draft.original, "# 规则\n")
        XCTAssertEqual(draft.version, String(repeating: "b", count: 64))
        XCTAssertEqual(draft.maxBytes, 100)
        XCTAssertFalse(draft.isChanged)
        XCTAssertFalse(draft.hasConflict)
    }

    func testTheDraftIsChangedWhileItsTextDiffersFromTheOriginal() throws {
        var draft = try draft()
        draft.text += "- 报告开头先写三行摘要。\n"
        XCTAssertTrue(draft.isChanged)
        draft.text = "# 规则\n"
        XCTAssertFalse(draft.isChanged, "typing the original back is no change")
        draft.text = "# 规则"
        XCTAssertTrue(draft.isChanged, "a missing final newline is a change")
    }

    // MARK: The limit

    func testTheByteCountIsUTF8Bytes() throws {
        var draft = try draft("")
        XCTAssertEqual(draft.byteCount, 0)
        draft.text = "abc"
        XCTAssertEqual(draft.byteCount, 3)
        draft.text = "规则"
        XCTAssertEqual(draft.byteCount, 6, "a Chinese character is three bytes")
        draft.text = "é🙂"
        XCTAssertEqual(draft.byteCount, 6, "two bytes and four")
    }

    func testTheTextIsOverTheLimitOnlyPastTheLastByte() throws {
        var draft = try draft("", maxBytes: 6)
        draft.text = "规则"
        XCTAssertEqual(draft.byteCount, 6)
        XCTAssertFalse(draft.isOverLimit, "exactly maxBytes is allowed")
        draft.text = "规则a"
        XCTAssertTrue(draft.isOverLimit)
        draft.text = "abcdefg"
        XCTAssertTrue(draft.isOverLimit, "the limit counts bytes, not characters: seven characters are over six bytes")
    }

    func testTheLimitComesFromTheServerAndNotFromTheApp() throws {
        var draft = try draft("", maxBytes: 20_000)
        draft.text = String(repeating: "a", count: 10_000)
        XCTAssertFalse(draft.isOverLimit)
        draft.text = String(repeating: "a", count: 20_001)
        XCTAssertTrue(draft.isOverLimit)
    }

    func testTheCountReadsBytesOutOfTheLimit() throws {
        var draft = try draft("", maxBytes: 8192)
        draft.text = "规则"
        XCTAssertEqual(draft.countText, "6 / 8192")
    }

    // MARK: Saving

    func testSavingIsOffUntilTheTextChanges() throws {
        var draft = try draft()
        XCTAssertFalse(draft.canSave(isSaving: false))
        draft.text += "x"
        XCTAssertTrue(draft.canSave(isSaving: false))
    }

    func testSavingIsOffOverTheLimitAndWhileASaveIsOut() throws {
        var draft = try draft("", maxBytes: 4)
        draft.text = "abcd"
        XCTAssertTrue(draft.canSave(isSaving: false))
        XCTAssertFalse(draft.canSave(isSaving: true), "a save is already out")
        draft.text = "abcde"
        XCTAssertFalse(draft.canSave(isSaving: false), "over the limit")
    }

    func testAnEmptiedTextCanBeSavedAsLongAsItDiffers() throws {
        var draft = try draft("# 规则\n")
        draft.text = ""
        XCTAssertTrue(draft.canSave(isSaving: false), "the owner may empty the rules")
    }

    // MARK: A conflict

    func testAConflictKeepsTheDraftAndItsVersion() throws {
        var draft = try draft("# 规则\n", version: String(repeating: "b", count: 64))
        draft.text = "# 我的规则\n"
        draft.noteConflict()
        XCTAssertTrue(draft.hasConflict)
        XCTAssertEqual(draft.text, "# 我的规则\n")
        XCTAssertEqual(draft.original, "# 规则\n")
        XCTAssertEqual(draft.version, String(repeating: "b", count: 64))

        draft.keepDraft()
        XCTAssertFalse(draft.hasConflict, "the owner stays in the editor")
        XCTAssertEqual(draft.text, "# 我的规则\n", "and keeps what was typed")
        XCTAssertEqual(draft.version, String(repeating: "b", count: 64), "the draft is still against the old version")
        XCTAssertTrue(draft.isChanged)
    }

    func testReloadingReplacesTheDraftWithTheNewContentAndItsVersion() throws {
        var draft = try draft("# 规则\n", version: String(repeating: "b", count: 64), maxBytes: 8192)
        draft.text = "# 我的规则\n"
        draft.noteConflict()

        draft.reload(try TestData.rules(text: "# 新规则\n", version: String(repeating: "c", count: 64), maxBytes: 4096))

        XCTAssertEqual(draft.text, "# 新规则\n")
        XCTAssertEqual(draft.original, "# 新规则\n")
        XCTAssertEqual(draft.version, String(repeating: "c", count: 64))
        XCTAssertEqual(draft.maxBytes, 4096)
        XCTAssertFalse(draft.hasConflict)
        XCTAssertFalse(draft.isChanged, "the reloaded draft starts unchanged")
    }
}
