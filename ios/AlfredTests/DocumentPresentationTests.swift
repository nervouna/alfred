import AlfredKit
import XCTest

@testable import Alfred

final class DocumentPresentationTests: XCTestCase {
    private typealias Presentation = DocumentPresentation

    // MARK: Paths

    func testAPathKnowsItsNameAndFolder() {
        XCTAssertEqual(Presentation.name(of: "notes/2026/hi.md"), "hi.md")
        XCTAssertEqual(Presentation.folder(of: "notes/2026/hi.md"), "notes/2026")
        XCTAssertEqual(Presentation.name(of: "hi.md"), "hi.md")
        XCTAssertEqual(Presentation.folder(of: "hi.md"), "")
    }

    // MARK: What made a version

    func testEachReasonHasItsWord() {
        XCTAssertEqual(Presentation.reasonLabel(.delivered), "交付")
        XCTAssertEqual(Presentation.reasonLabel(.revised), "修订")
        XCTAssertEqual(Presentation.reasonLabel(.undone), "撤销")
        XCTAssertEqual(Presentation.reasonLabel(.changed), "修改")
        XCTAssertEqual(Presentation.reasonLabel(DocumentVersionReason(rawValue: "merged")), "merged", "a reason this app does not know shows as written")
    }

    // MARK: The list

    func testRowsAreNumberedFromTheFirstVersionAndTheNewestIsCurrent() throws {
        let rows = Presentation.rows(of: try TestData.threeVersions())

        XCTAssertEqual(rows.map(\.number), [3, 2, 1])
        XCTAssertEqual(rows.map(\.title), ["第 3 版", "第 2 版", "第 1 版"])
        XCTAssertEqual(rows.map(\.reason), ["修改", "修订", "交付"])
        XCTAssertEqual(rows.map(\.runId), ["t4w9xr", "s2d8kp", "k7m2qa"])
        XCTAssertEqual(rows.map(\.isCurrent), [true, false, false])
        XCTAssertEqual(rows.map(\.version), [TestData.commit(3), TestData.commit(2), TestData.commit(1)])
    }

    func testAnUndoneVersionHasNoRun() throws {
        let versions = [
            try TestData.version(TestData.commit(2), reason: "undone", runId: nil, undoes: "x4n7mj"),
            try TestData.version(TestData.commit(1)),
        ]
        let rows = Presentation.rows(of: versions)
        XCTAssertEqual(rows.first?.reason, "撤销")
        XCTAssertNil(rows.first?.runId)
    }

    func testNoVersionsMakeNoRows() {
        XCTAssertEqual(Presentation.rows(of: []), [])
    }

    func testAVersionKnowsItsNumberAndTheVersionBeforeIt() throws {
        let versions = try TestData.threeVersions()
        XCTAssertEqual(Presentation.number(of: TestData.commit(3), in: versions), 3)
        XCTAssertEqual(Presentation.number(of: TestData.commit(1), in: versions), 1)
        XCTAssertNil(Presentation.number(of: TestData.commit(9), in: versions))

        XCTAssertEqual(Presentation.previous(of: TestData.commit(3), in: versions), TestData.commit(2))
        XCTAssertEqual(Presentation.previous(of: TestData.commit(2), in: versions), TestData.commit(1))
        XCTAssertNil(Presentation.previous(of: TestData.commit(1), in: versions), "the first version has none before it")
        XCTAssertNil(Presentation.previous(of: TestData.commit(9), in: versions), "a version the list does not hold has none either")
    }

    // MARK: The banner

    func testTheCurrentVersionHasNoBanner() throws {
        let versions = try TestData.threeVersions()
        let current = TestData.commit(3)
        XCTAssertNil(Presentation.banner(shown: nil, current: current, fromMessage: false, versions: versions))
        XCTAssertNil(Presentation.banner(shown: current, current: current, fromMessage: false, versions: versions))
        XCTAssertNil(
            Presentation.banner(shown: current, current: current, fromMessage: true, versions: versions),
            "a message that delivered the current version has nothing newer to point at"
        )
    }

    func testAVersionFromTheListSaysWhichVersionItIsAndOffersTheCurrentOne() throws {
        let banner = try XCTUnwrap(Presentation.banner(
            shown: TestData.commit(1), current: TestData.commit(3), fromMessage: false, versions: try TestData.threeVersions()
        ))
        XCTAssertEqual(banner.title, "正在查看第 1 版（交付）")
        XCTAssertTrue(banner.detail?.hasPrefix("只读") == true, "\(banner.detail ?? "nil")")
        XCTAssertEqual(banner.action, "回到当前版本")
    }

    func testAVersionTheListDoesNotHoldStillGetsABanner() throws {
        let banner = try XCTUnwrap(Presentation.banner(
            shown: TestData.commit(9), current: TestData.commit(3), fromMessage: false, versions: try TestData.threeVersions()
        ))
        XCTAssertEqual(banner.title, "正在查看旧版本")
        XCTAssertEqual(banner.detail, "只读")
    }

    func testAMessagesVersionSaysAnewerOneExists() throws {
        let banner = try XCTUnwrap(Presentation.banner(
            shown: TestData.commit(2), current: TestData.commit(3), fromMessage: true, versions: try TestData.threeVersions()
        ))
        XCTAssertEqual(banner.title, "有更新的版本")
        XCTAssertEqual(banner.detail, "这条消息交付的是第 2 版")
        XCTAssertEqual(banner.action, "查看最新版本")
    }

    func testAMessagesVersionTheListDoesNotHoldStillSaysAnewerOneExists() throws {
        let banner = try XCTUnwrap(Presentation.banner(
            shown: TestData.commit(9), current: TestData.commit(3), fromMessage: true, versions: []
        ))
        XCTAssertEqual(banner.title, "有更新的版本")
        XCTAssertNil(banner.detail)
    }

    // MARK: Where a file of a message opens

    func testAFileOfAnOutboundMessageThatNamesADocumentOpensTheDocumentAtTheMessagesVersion() throws {
        let file = TestData.fileObject("reports/weekly.md", documentId: "aaaaaa", version: TestData.commit(2))
        let message = try TestData.messageWithFiles("m1", files: [file])
        let target = Presentation.FileTarget(file: try XCTUnwrap(message.files.first), in: message)
        XCTAssertEqual(target, .document(id: "aaaaaa", version: TestData.commit(2)))
    }

    func testAFileWithoutADocumentOpensTheViewer() throws {
        let message = try TestData.messageWithFiles("m1", files: [TestData.fileObject("notes/old.md")])
        let target = Presentation.FileTarget(file: try XCTUnwrap(message.files.first), in: message)
        XCTAssertEqual(target, .file(path: "notes/old.md"))
    }

    func testAnUploadOfTheOwnerOpensTheViewer() throws {
        let file = TestData.fileObject("inbox/2026-10-26/photo.png", documentId: "aaaaaa", version: TestData.commit(1))
        let message = try TestData.messageWithFiles("m1", direction: "in", files: [file])
        let target = Presentation.FileTarget(file: try XCTUnwrap(message.files.first), in: message)
        XCTAssertEqual(target, .file(path: "inbox/2026-10-26/photo.png"))
    }

    func testEachFileOfAMessageChoosesForItself() throws {
        let message = try TestData.messageWithFiles("m1", files: [
            TestData.fileObject("reports/a.md", documentId: "aaaaaa", version: TestData.commit(1)),
            TestData.fileObject("scratch/b.md"),
        ])
        XCTAssertEqual(
            message.files.map { Presentation.FileTarget(file: $0, in: message) },
            [.document(id: "aaaaaa", version: TestData.commit(1)), .file(path: "scratch/b.md")]
        )
    }
}
