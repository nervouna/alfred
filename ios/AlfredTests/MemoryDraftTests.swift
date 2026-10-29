import AlfredKit
import XCTest

@testable import Alfred

/// The owner's edit of a memory, apart from the form that shows it.
final class MemoryDraftTests: XCTestCase {
    private func editing(
        _ name: String = "回答要简短",
        description: String = "先给结论，再给理由。",
        kind: String = "preference",
        body: String = "主人在手机上看回复。"
    ) throws -> MemoryDraft {
        MemoryDraft(editing: try TestData.memory(name, description: description, kind: kind, body: body))
    }

    // MARK: What it holds

    func testANewDraftIsEmptyAndStartsOnTheFirstKind() {
        let draft = MemoryDraft()
        XCTAssertNil(draft.file)
        XCTAssertNil(draft.version)
        XCTAssertTrue(draft.isNew)
        XCTAssertEqual(draft.name, "")
        XCTAssertEqual(draft.description, "")
        XCTAssertEqual(draft.kind, "user")
        XCTAssertEqual(draft.body, "")
        XCTAssertFalse(draft.isChanged)
    }

    func testTheKindsAreTheFourTheContractTakesInTheOrderOfTheSections() {
        XCTAssertEqual(MemoryDraft.kinds, ["user", "preference", "project", "correction"])
    }

    func testAnEditStartsAsTheMemoryWithNothingChanged() throws {
        let memory = try TestData.memory("回答要简短", file: "prefer-short-answers.md", description: "先给结论。", kind: "preference", body: "正文", version: "v1")
        let draft = MemoryDraft(editing: memory)
        XCTAssertEqual(draft.file, "prefer-short-answers.md")
        XCTAssertEqual(draft.version, "v1")
        XCTAssertFalse(draft.isNew)
        XCTAssertEqual(draft.name, "回答要简短")
        XCTAssertEqual(draft.description, "先给结论。")
        XCTAssertEqual(draft.kind, "preference")
        XCTAssertEqual(draft.body, "正文")
        XCTAssertFalse(draft.isChanged)
    }

    // MARK: Change detection

    func testEachFieldChangesTheDraftAndTypingTheOriginalBackDoesNot() throws {
        var draft = try editing()
        draft.name += "！"
        XCTAssertTrue(draft.isChanged)
        draft.name = "回答要简短"
        XCTAssertFalse(draft.isChanged)

        draft.description = "不同"
        XCTAssertTrue(draft.isChanged)
        draft.description = "先给结论，再给理由。"
        XCTAssertFalse(draft.isChanged)

        draft.kind = "project"
        XCTAssertTrue(draft.isChanged)
        draft.kind = "preference"
        XCTAssertFalse(draft.isChanged)

        draft.body += "\n"
        XCTAssertTrue(draft.isChanged, "a final newline in the body is a change")
        draft.body = "主人在手机上看回复。"
        XCTAssertFalse(draft.isChanged)
    }

    func testSpacesAroundTheNameOrTheDescriptionAreNoChange() throws {
        var draft = try editing()
        draft.name = "  回答要简短 "
        draft.description = "先给结论，再给理由。  "
        XCTAssertFalse(draft.isChanged, "the line is trimmed before it is sent, so it is as it was")
        XCTAssertEqual(draft.sentName, "回答要简短")
        XCTAssertEqual(draft.sentDescription, "先给结论，再给理由。")
    }

    func testANewDraftIsChangedOnceAnythingIsTyped() {
        var draft = MemoryDraft()
        draft.body = "x"
        XCTAssertTrue(draft.isChanged)
        draft.body = ""
        draft.kind = "project"
        XCTAssertTrue(draft.isChanged, "another kind than the first is a change")
    }

    // MARK: The name

    func testTheNameNeedsOneToEightyCharacters() throws {
        var draft = try editing()
        draft.name = ""
        XCTAssertEqual(draft.problems, [.nameEmpty])
        draft.name = "   "
        XCTAssertEqual(draft.problems, [.nameEmpty], "spaces alone are an empty name")
        draft.name = "a"
        XCTAssertTrue(draft.problems.isEmpty)
        draft.name = String(repeating: "名", count: 80)
        XCTAssertTrue(draft.problems.isEmpty, "eighty characters are allowed")
        draft.name = String(repeating: "名", count: 81)
        XCTAssertEqual(draft.problems, [.nameTooLong])
    }

    func testCharactersAreCountedAsTheServerCountsThem() throws {
        var draft = try editing()
        // The server counts code points: a flag is two.
        draft.name = String(repeating: "🇨🇳", count: 40)
        XCTAssertEqual(draft.name.count, 40)
        XCTAssertTrue(draft.problems.isEmpty, "forty flags are eighty code points")
        draft.name = String(repeating: "🇨🇳", count: 41)
        XCTAssertEqual(draft.problems, [.nameTooLong], "forty-one flags are eighty-two")
    }

    func testTheNameIsOneLine() throws {
        var draft = try editing()
        for text in ["a\nb", "a\rb", "a\tb", "a\u{2028}b", "a\u{2029}b", "a\u{0}b"] {
            draft.name = text
            XCTAssertEqual(draft.problems, [.nameNotOneLine], "\(text.debugDescription) is not one line")
        }
        draft.name = "a b"
        XCTAssertTrue(draft.problems.isEmpty, "a space is fine inside a line")
    }

    // MARK: The description

    func testTheDescriptionMayBeEmptyAndHoldsAtMostTwoHundredCharacters() throws {
        var draft = try editing()
        draft.description = ""
        XCTAssertTrue(draft.problems.isEmpty)
        draft.description = String(repeating: "述", count: 200)
        XCTAssertTrue(draft.problems.isEmpty)
        draft.description = String(repeating: "述", count: 201)
        XCTAssertEqual(draft.problems, [.descriptionTooLong])
    }

    func testTheDescriptionIsOneLine() throws {
        var draft = try editing()
        draft.description = "第一行\n第二行"
        XCTAssertEqual(draft.problems, [.descriptionNotOneLine])
        draft.description = "第一行\n"
        XCTAssertTrue(draft.problems.isEmpty, "a newline at the end is trimmed away")
    }

    // MARK: The body

    func testTheBodyHoldsAtMostEightThousandOneHundredNinetyTwoBytes() throws {
        var draft = try editing()
        draft.body = String(repeating: "a", count: 8192)
        XCTAssertEqual(draft.bodyByteCount, 8192)
        XCTAssertFalse(draft.isBodyOverLimit)
        XCTAssertTrue(draft.problems.isEmpty)
        draft.body += "a"
        XCTAssertTrue(draft.isBodyOverLimit)
        XCTAssertEqual(draft.problems, [.bodyTooLong])
    }

    func testTheBodyIsCountedInUTF8BytesNotCharacters() throws {
        var draft = try editing()
        draft.body = String(repeating: "规", count: 2730)
        XCTAssertEqual(draft.bodyByteCount, 8190)
        XCTAssertFalse(draft.isBodyOverLimit)
        draft.body += "则"
        XCTAssertEqual(draft.bodyByteCount, 8193)
        XCTAssertTrue(draft.isBodyOverLimit, "2731 characters are over 8192 bytes")
        XCTAssertEqual(draft.bodyCountText, "8193 / 8192")
    }

    func testTheBodyMayHoldNewlinesButNotANul() throws {
        var draft = try editing()
        draft.body = "一行\n又一行\n"
        XCTAssertTrue(draft.problems.isEmpty)
        draft.body = "a\u{0}b"
        XCTAssertEqual(draft.problems, [.bodyHasNul])
    }

    // MARK: The kind

    func testTheKindMustBeOneOfTheFour() throws {
        var draft = try editing()
        for kind in MemoryDraft.kinds {
            draft.kind = kind
            XCTAssertTrue(draft.problems.isEmpty)
        }
        draft.kind = "feedback"
        XCTAssertEqual(draft.problems, [.kindUnknown])
    }

    func testAMemoryOfAnOlderKindOffersItsKindBesideTheFourUntilAnotherIsChosen() throws {
        var draft = try editing(kind: "feedback")
        XCTAssertEqual(draft.kindChoices, ["user", "preference", "project", "correction", "feedback"])
        XCTAssertEqual(draft.problems, [.kindUnknown])
        draft.name += "！"
        XCTAssertFalse(draft.canSave(isSaving: false), "the kind must be chosen before the memory is saved")
        draft.kind = "project"
        XCTAssertEqual(draft.kindChoices, ["user", "preference", "project", "correction", "feedback"], "the choices do not move once the owner picks")
        XCTAssertTrue(draft.canSave(isSaving: false))

        XCTAssertEqual(try editing(kind: "").kindChoices.last, "")
        XCTAssertEqual(try editing(kind: "project").kindChoices, MemoryDraft.kinds)
    }

    // MARK: What the form says

    func testEachProblemHasItsWordsExceptTheOnesTheFormShowsInAnotherWay() {
        XCTAssertNil(MemoryDraft.Problem.nameEmpty.message, "保存 being off says it")
        XCTAssertNil(MemoryDraft.Problem.bodyTooLong.message, "the count in red says it")
        XCTAssertEqual(MemoryDraft.Problem.nameTooLong.message, "名称最多 80 个字符")
        XCTAssertEqual(MemoryDraft.Problem.descriptionTooLong.message, "描述最多 200 个字符")
        XCTAssertEqual(MemoryDraft.Problem.nameNotOneLine.message, "名称只能写一行")
        XCTAssertEqual(MemoryDraft.Problem.descriptionNotOneLine.message, "描述只能写一行")
        XCTAssertEqual(MemoryDraft.Problem.kindUnknown.message, "请选择一个类型")
        XCTAssertNotNil(MemoryDraft.Problem.bodyHasNul.message)
    }

    // MARK: Saving

    func testSavingNeedsAValidDraftThatChangedAndNoSaveOut() throws {
        var draft = try editing()
        XCTAssertFalse(draft.canSave(isSaving: false), "nothing changed")
        draft.body += "x"
        XCTAssertTrue(draft.canSave(isSaving: false))
        XCTAssertFalse(draft.canSave(isSaving: true), "a save is out")
        draft.name = ""
        XCTAssertFalse(draft.canSave(isSaving: false), "an empty name")
        draft.name = "名"
        draft.description = "a\nb"
        XCTAssertFalse(draft.canSave(isSaving: false), "a description of two lines")
    }

    func testANewDraftCanBeSavedOnceItHasAName() {
        var draft = MemoryDraft()
        XCTAssertFalse(draft.canSave(isSaving: false))
        draft.body = "只有正文"
        XCTAssertFalse(draft.canSave(isSaving: false), "a name is needed")
        draft.name = "名称"
        XCTAssertTrue(draft.canSave(isSaving: false))
    }

    // MARK: Reloading

    func testReloadingTakesTheMemoryAsItIsNowAndDropsWhatWasTyped() throws {
        var draft = try editing()
        draft.name = "我改的"
        draft.body = "我写的"
        let newer = try TestData.memory("别处改的", file: "x.md", description: "d", kind: "project", body: "b", version: "v2")

        draft.reload(newer)

        XCTAssertEqual(draft.name, "别处改的")
        XCTAssertEqual(draft.body, "b")
        XCTAssertEqual(draft.kind, "project")
        XCTAssertEqual(draft.version, "v2")
        XCTAssertFalse(draft.isChanged)
    }

    // MARK: Conflicts

    func testAConflictWithoutAMessageOrWithTheVersionMessageIsAStaleVersion() {
        XCTAssertTrue(MemoryConflict.isStaleVersion(message: nil))
        XCTAssertTrue(MemoryConflict.isStaleVersion(message: "version: not the current version of prefer-short-answers.md"))
        XCTAssertFalse(MemoryConflict.isStaleVersion(message: "Alfred is tidying memory right now; try again shortly."))
        XCTAssertFalse(MemoryConflict.isStaleVersion(message: "memory/ is not a folder in the workspace, so nothing is added to it"))
    }
}
