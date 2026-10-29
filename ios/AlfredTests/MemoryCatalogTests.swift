import AlfredKit
import XCTest

@testable import Alfred

final class MemoryCatalogTests: XCTestCase {
    private func catalog(_ memories: [[String: Any]], promptCount: Int? = nil) throws -> MemoryCatalog {
        var catalog = MemoryCatalog()
        catalog.load(try TestData.memoryList(memories, promptCount: promptCount))
        return catalog
    }

    /// One of each kind, an older kind, and two of the user's, in the server's order.
    private func mixed() throws -> MemoryCatalog {
        try catalog([
            TestData.memoryObject("项目 A", kind: "project", updated: "2026-10-29"),
            TestData.memoryObject("住在上海", kind: "user", updated: "2026-10-28"),
            TestData.memoryObject("先给结论", kind: "preference", updated: "2026-10-27"),
            TestData.memoryObject("不要猜价格", kind: "correction", updated: "2026-10-26"),
            TestData.memoryObject("周会", kind: "feedback", updated: ""),
            TestData.memoryObject("喜欢咖啡", kind: "user", updated: "2026-10-25"),
        ], promptCount: 4)
    }

    // MARK: Loading

    func testACatalogThatHasReadNothingHasNoMemories() {
        let catalog = MemoryCatalog()
        XCTAssertFalse(catalog.hasLoaded)
        XCTAssertTrue(catalog.memories.isEmpty)
        XCTAssertTrue(catalog.sections(matching: "").isEmpty)
    }

    func testAReadKeepsTheServersOrderAndMarksTheCatalogLoaded() throws {
        let catalog = try mixed()
        XCTAssertTrue(catalog.hasLoaded)
        XCTAssertEqual(catalog.memories.map(\.name), ["项目 A", "住在上海", "先给结论", "不要猜价格", "周会", "喜欢咖啡"])
        XCTAssertEqual(try self.catalog([]).memories.count, 0)
        XCTAssertTrue(try self.catalog([]).hasLoaded, "an empty list is a list")
    }

    func testAReadReplacesWhatWasHeld() throws {
        var catalog = try mixed()
        catalog.load(try TestData.memoryList([TestData.memoryObject("只剩一条")]))
        XCTAssertEqual(catalog.memories.map(\.name), ["只剩一条"])
    }

    func testAMemoryIsFoundByItsFile() throws {
        let catalog = try mixed()
        XCTAssertEqual(catalog.memory(file: "住在上海.md")?.name, "住在上海")
        XCTAssertNil(catalog.memory(file: "no-such.md"))
    }

    // MARK: The prompt

    func testTheFirstPromptCountMemoriesAreInThePromptAndTheRestAreNot() throws {
        let catalog = try mixed()
        XCTAssertEqual(catalog.memories.map { catalog.isInPrompt($0) }, [true, true, true, true, false, false])
    }

    func testNoneAreOutOfThePromptWhenAllFit() throws {
        let catalog = try catalog([TestData.memoryObject("甲"), TestData.memoryObject("乙")], promptCount: 2)
        XCTAssertTrue(catalog.memories.allSatisfy { catalog.isInPrompt($0) })
    }

    // MARK: Sections

    func testTheSectionsFollowTheOrderOfTheKindsAndLeaveEmptyOnesOut() throws {
        let sections = try mixed().sections(matching: "")
        XCTAssertEqual(sections.map(\.kind), [.user, .preference, .project, .correction, .other])
        XCTAssertEqual(sections.map(\.kind.title), ["关于你", "偏好", "项目", "纠正", "其他"])

        let some = try catalog([
            TestData.memoryObject("甲", kind: "project"),
            TestData.memoryObject("乙", kind: "correction"),
        ]).sections(matching: "")
        XCTAssertEqual(some.map(\.kind), [.project, .correction], "a kind with no memory has no section")
    }

    func testAMemoryOfAnyOtherKindOrNoneIsInTheLastSection() throws {
        let sections = try catalog([
            TestData.memoryObject("甲", kind: "feedback"),
            TestData.memoryObject("乙", kind: ""),
            TestData.memoryObject("丙", kind: "USER"),
        ]).sections(matching: "")
        XCTAssertEqual(sections.map(\.kind), [.other])
        XCTAssertEqual(sections.first?.memories.map(\.name), ["甲", "乙", "丙"])
    }

    func testWithinASectionTheOrderIsTheServers() throws {
        let sections = try mixed().sections(matching: "")
        XCTAssertEqual(sections.first?.memories.map(\.name), ["住在上海", "喜欢咖啡"])
    }

    func testTheKindsHaveTheirTitlesAndSymbols() {
        XCTAssertEqual(MemoryKind.allCases, [.user, .preference, .project, .correction, .other])
        XCTAssertEqual(MemoryKind.allCases.map(\.title), ["关于你", "偏好", "项目", "纠正", "其他"])
        XCTAssertEqual(Set(MemoryKind.allCases.map(\.symbol)).count, 5, "each kind has a symbol of its own")
        XCTAssertEqual(MemoryKind("user"), .user)
        XCTAssertEqual(MemoryKind("preference"), .preference)
        XCTAssertEqual(MemoryKind("project"), .project)
        XCTAssertEqual(MemoryKind("correction"), .correction)
        XCTAssertEqual(MemoryKind("anything"), .other)
    }

    // MARK: Search

    func testSearchMatchesTheNameTheDescriptionAndTheBody() throws {
        let catalog = try catalog([
            TestData.memoryObject("甲", description: "说到咖啡", body: "x"),
            TestData.memoryObject("乙", description: "y", body: "他每天喝咖啡"),
            TestData.memoryObject("咖啡机", description: "z", body: "x"),
            TestData.memoryObject("丙", description: "茶", body: "茶"),
        ])
        XCTAssertEqual(catalog.sections(matching: "咖啡").flatMap(\.memories).map(\.name), ["甲", "乙", "咖啡机"])
    }

    func testSearchIgnoresCaseAndSpacesAroundTheQuery() throws {
        let catalog = try catalog([TestData.memoryObject("Alfred Project", body: "A Node backend"), TestData.memoryObject("其他")])
        XCTAssertEqual(catalog.sections(matching: "alfred").flatMap(\.memories).map(\.name), ["Alfred Project"])
        XCTAssertEqual(catalog.sections(matching: "  NODE ").flatMap(\.memories).map(\.name), ["Alfred Project"])
    }

    func testAnEmptyQueryShowsEverythingAndOneThatMatchesNothingShowsNothing() throws {
        let catalog = try mixed()
        XCTAssertEqual(catalog.sections(matching: "").flatMap(\.memories).count, 6)
        XCTAssertEqual(catalog.sections(matching: "   ").flatMap(\.memories).count, 6)
        XCTAssertTrue(catalog.sections(matching: "不存在的词").isEmpty)
    }

    func testSearchKeepsTheSectionsAndTheOrderAndLeavesOutSectionsWithNoMatch() throws {
        let sections = try mixed().sections(matching: "项目")
        XCTAssertEqual(sections.map(\.kind), [.project])
        XCTAssertEqual(sections.first?.memories.map(\.name), ["项目 A"])
    }

    func testSearchDoesNotChangeWhichMemoriesAreInThePrompt() throws {
        let catalog = try mixed()
        let found = try XCTUnwrap(catalog.sections(matching: "喜欢咖啡").first?.memories.first)
        XCTAssertFalse(catalog.isInPrompt(found), "it is the last of six, and four fit")
    }

    // MARK: After the owner's own changes

    func testASavedMemoryReplacesItsOldVersionAndMovesToTheTop() throws {
        var catalog = try mixed()
        let saved = try TestData.memory("先给结论，再给理由", file: "先给结论.md", kind: "preference", updated: "2026-10-30", version: "new")

        catalog.apply(saved)

        XCTAssertEqual(catalog.memories.count, 6, "it replaced the old one")
        XCTAssertEqual(catalog.memories.first?.name, "先给结论，再给理由", "an edit dates the memory today, which is the newest")
        XCTAssertEqual(catalog.memory(file: "先给结论.md")?.version, "new")
    }

    func testANewMemoryGoesToTheTop() throws {
        var catalog = try mixed()
        catalog.apply(try TestData.memory("新的", updated: "2026-10-30"))
        XCTAssertEqual(catalog.memories.count, 7)
        XCTAssertEqual(catalog.memories.first?.name, "新的")
    }

    func testANewMemoryJoinsThePromptWhenEverythingWasInIt() throws {
        var catalog = try catalog([TestData.memoryObject("甲"), TestData.memoryObject("乙")], promptCount: 2)
        catalog.apply(try TestData.memory("新的"))
        XCTAssertEqual(catalog.promptCount, 3, "all were in the prompt, and the new one is the newest")
        XCTAssertTrue(catalog.memories.allSatisfy { catalog.isInPrompt($0) })

        var capped = try mixed()
        capped.apply(try TestData.memory("新的"))
        XCTAssertEqual(capped.promptCount, 4, "the cap was hit, so the new one pushes the last out")
    }

    func testARemovedMemoryLeavesAtOnceAndTheRestKeepTheirPlaceInThePrompt() throws {
        var catalog = try mixed()
        catalog.remove(file: "住在上海.md")
        XCTAssertEqual(catalog.memories.map(\.name), ["项目 A", "先给结论", "不要猜价格", "周会", "喜欢咖啡"])
        XCTAssertNil(catalog.memory(file: "住在上海.md"))
        XCTAssertEqual(catalog.promptCount, 3, "one of the memories in the prompt is gone")

        catalog.remove(file: "喜欢咖啡.md")
        XCTAssertEqual(catalog.promptCount, 3, "one that was not in the prompt does not change it")
        catalog.remove(file: "no-such.md")
        XCTAssertEqual(catalog.memories.count, 4)
    }

    func testRemovingTheLastMemoryLeavesALoadedEmptyCatalog() throws {
        var catalog = try catalog([TestData.memoryObject("甲")])
        catalog.remove(file: "甲.md")
        XCTAssertTrue(catalog.hasLoaded)
        XCTAssertTrue(catalog.memories.isEmpty)
    }

    // MARK: A read that began before a change

    func testAReadThatBeganBeforeAChangeDoesNotUndoIt() throws {
        var catalog = try mixed()
        let revision = catalog.revision

        catalog.remove(file: "住在上海.md")
        catalog.load(try TestData.memoryList([TestData.memoryObject("住在上海", kind: "user")]), requestedAt: revision)

        XCTAssertEqual(catalog.memories.count, 5, "the list was read before the delete, so it is out of date")
        XCTAssertNil(catalog.memory(file: "住在上海.md"))
    }

    func testAReadThatBeganAfterTheLastChangeIsTaken() throws {
        var catalog = try mixed()
        catalog.remove(file: "住在上海.md")
        catalog.load(try TestData.memoryList([TestData.memoryObject("只剩一条")]), requestedAt: catalog.revision)
        XCTAssertEqual(catalog.memories.map(\.name), ["只剩一条"])
    }

    func testAFirstReadThatBeganBeforeAChangeIsLeftForTheNextOne() throws {
        var catalog = MemoryCatalog()
        let revision = catalog.revision
        catalog.apply(try TestData.memory("新的"))
        catalog.load(try TestData.memoryList([TestData.memoryObject("新的"), TestData.memoryObject("旧的")]), requestedAt: revision)
        XCTAssertFalse(catalog.hasLoaded, "a read that is out of date says nothing, and the next one will")
        XCTAssertEqual(catalog.memories.map(\.name), ["新的"])
    }
}
