import AlfredKit
import Foundation
import XCTest

final class DocumentFixtureTests: XCTestCase {
    private let version = "5d726c9ddcb2d6a8fad41e6213426bdeb94c6acd"

    private func decodeEvent(_ name: String) throws -> Event {
        try JSONDecoder().decode(Event.self, from: Data(contentsOf: Fixtures.directory.appending(path: name)))
    }

    private func decodeCommand(_ name: String) throws -> Command {
        try JSONDecoder().decode(Command.self, from: Data(contentsOf: Fixtures.directory.appending(path: name)))
    }

    private func decodeFixture<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(contentsOf: Fixtures.directory.appending(path: name)))
    }

    func testDeliveredDocumentFieldsAreDecoded() throws {
        guard case let .documentUpdated(document) = try decodeEvent("events/document-updated-delivered.json").payload else {
            return XCTFail("expected a document.updated event")
        }
        XCTAssertEqual(document.id, "r4f7ma")
        XCTAssertEqual(document.path, "reports/vps.md")
        XCTAssertEqual(document.title, "VPS 价格对比")
        XCTAssertEqual(document.kind, .markdown)
        XCTAssertNil(document.taskId)
        XCTAssertEqual(document.version, "248e89ba3aad47311d9cf0d57bf83b038a724f1f")
    }

    func testTaskDocumentNamesItsTask() throws {
        guard case let .documentUpdated(document) = try decodeEvent("events/document-updated-task.json").payload else {
            return XCTFail("expected a document.updated event")
        }
        XCTAssertEqual(document.kind, .html)
        XCTAssertEqual(document.taskId, "p3r8vx")
    }

    func testRemovedDocumentEventNamesTheDocument() throws {
        let event = try decodeEvent("events/document-removed.json")
        XCTAssertEqual(event.id, 36)
        guard case let .documentRemoved(id) = event.payload else {
            return XCTFail("expected a document.removed event, got \(event.payload)")
        }
        XCTAssertEqual(id, "r4f7ma")
    }

    /// The annotation of an annotation.updated fixture, or nil for any other event.
    private func annotation(_ name: String) throws -> Annotation? {
        guard case let .annotationUpdated(annotation) = try decodeEvent(name).payload else { return nil }
        return annotation
    }

    func testAnnotationEventsCarryTheirStates() throws {
        let submitted = try XCTUnwrap(annotation("events/annotation-updated-submitted.json"))
        XCTAssertEqual(submitted.state, .submitted)
        XCTAssertEqual(submitted.target, .passage(quote: "Hetzner 的 CX22 仍是 €4.51/月", prefix: "对比结论：", suffix: "，其余两家都上涨了。"))
        XCTAssertNil(submitted.reply)
        XCTAssertNil(submitted.returnReason)

        let resolved = try XCTUnwrap(annotation("events/annotation-updated-resolved.json"))
        XCTAssertEqual(resolved.state, .resolved)
        XCTAssertEqual(resolved.target, .document)
        XCTAssertNotNil(resolved.reply)

        let undone = try XCTUnwrap(annotation("events/annotation-updated-returned-undone.json"))
        XCTAssertEqual(undone.state, .returned)
        XCTAssertEqual(undone.returnReason, .undone)
        XCTAssertNotNil(undone.reply, "an answer kept through an undo")

        let unanswered = try XCTUnwrap(annotation("events/annotation-updated-returned-unanswered.json"))
        XCTAssertEqual(unanswered.returnReason, .unanswered)
        XCTAssertNil(unanswered.reply)
    }

    func testRevisionRunNamesItsDocument() throws {
        guard case let .runUpdated(run) = try decodeEvent("events/run-updated-revision.json").payload else {
            return XCTFail("expected a run.updated event")
        }
        XCTAssertEqual(run.kind, .revision)
        XCTAssertEqual(run.documentId, "r4f7ma")
        XCTAssertNil(run.taskId)
    }

    func testDeliveredFileNamesItsDocumentAndVersion() throws {
        guard case let .messageCreated(message) = try decodeEvent("events/message-created-delivery-document.json").payload else {
            return XCTFail("expected a message.created event")
        }
        let file = try XCTUnwrap(message.files.first)
        XCTAssertEqual(file.path, "reports/vps.md")
        XCTAssertEqual(file.documentId, "r4f7ma")
        XCTAssertEqual(file.version, "248e89ba3aad47311d9cf0d57bf83b038a724f1f")
    }

    func testTimelineLeavesDocumentsOutOfTheChat() throws {
        var timeline = Timeline()
        timeline.apply(.event(try decodeEvent("events/document-updated-delivered.json")))
        timeline.apply(.event(try decodeEvent("events/annotation-updated-submitted.json")))
        XCTAssertEqual(timeline.messages, [])
        XCTAssertEqual(timeline.lastEventId, 29)
        timeline.apply(.event(try decodeEvent("events/document-removed.json")))
        XCTAssertEqual(timeline.messages, [])
        XCTAssertEqual(timeline.lastEventId, 36)
    }

    func testAnnotationTargetRoundTripsBothKinds() throws {
        for target in [AnnotationTarget.passage(quote: "价格", prefix: "", suffix: "。"), .document] {
            let encoded = try JSONEncoder().encode(target)
            XCTAssertEqual(try JSONDecoder().decode(AnnotationTarget.self, from: encoded), target)
        }
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(AnnotationTarget.document)) as? [String: String])
        XCTAssertEqual(json, ["kind": "document"])
        XCTAssertThrowsError(try JSONDecoder().decode(AnnotationTarget.self, from: Data(#"{"kind":"page","page":1}"#.utf8)))
    }

    func testReviseCommandCarriesItsBatch() throws {
        XCTAssertEqual(
            try decodeCommand("commands/document-revise.json"),
            .documentRevise(documentId: "r4f7ma", version: version, annotations: [
                AnnotationDraft(
                    target: .passage(quote: "Hetzner 的 CX22 仍是 €4.51/月", prefix: "对比结论：", suffix: "，其余两家都上涨了。"),
                    comment: "这个价格请再核对一下官网，别用缓存的数据。"
                ),
                AnnotationDraft(target: .passage(quote: "DigitalOcean 的基础款降到 $4", prefix: "", suffix: "/月。"), comment: "这一条的日期也写上。"),
                AnnotationDraft(target: .document, comment: "开头加一段三句话的结论。"),
            ])
        )
        XCTAssertEqual(
            try decodeCommand("commands/document-revise-document-comment.json"),
            .documentRevise(documentId: "r4f7ma", version: version, annotations: [
                AnnotationDraft(target: .document, comment: "开头加一段三句话的结论。"),
            ])
        )
    }

    func testUndoCommandCarriesTheRevisionRun() throws {
        XCTAssertEqual(try decodeCommand("commands/document-undo.json"), .documentUndo(documentId: "r4f7ma", runId: "x4n7mj"))
    }

    func testDocumentDetailHasItsVersionsAnnotationsAndRuns() throws {
        let detail = try decodeFixture(DocumentDetail.self, "responses/document-detail.json")
        XCTAssertEqual(detail.document.id, "r4f7ma")
        XCTAssertEqual(detail.versions.map(\.reason), [.undone, .revised, .revised, .delivered])
        XCTAssertEqual(detail.versions.first?.version, detail.document.version)
        XCTAssertNil(detail.versions[0].runId, "an undone version has no run")
        XCTAssertEqual(detail.versions[0].undoes, "x4n7mj")
        XCTAssertEqual(detail.versions[1].runId, "x4n7mj")
        XCTAssertEqual(Set(detail.annotations.map(\.state)), [.submitted, .resolved, .returned])
        XCTAssertEqual(detail.runs.map(\.id), ["s2d8kp", "x4n7mj", "m2v8pd"])
        XCTAssertEqual(Set(detail.runs.map(\.kind)), [.revision])
    }

    func testRevisionAcceptedIsTheBatchSubmittedToItsRun() throws {
        let accepted = try decodeFixture(RevisionAccepted.self, "responses/revision-accepted.json")
        XCTAssertEqual(accepted.runId, "s2d8kp")
        XCTAssertEqual(accepted.annotations.map(\.id), ["g7e4xr", "k6p3dh", "t4r7ww"])
        XCTAssertTrue(accepted.annotations.allSatisfy { $0.state == .submitted && $0.runId == "s2d8kp" })
    }

    func testDocumentListAndResultDecode() throws {
        let list = try decodeFixture(DocumentList.self, "responses/document-list.json")
        XCTAssertEqual(list.documents.map(\.id), ["r4f7ma", "w6k2tn"])
        let result = try decodeFixture(DocumentResult.self, "responses/document-result.json")
        XCTAssertEqual(result.document, list.documents.first)
    }

    func testAnUnknownDocumentKindDecodesAsItself() throws {
        let json = """
        {"id":"e3s9hq","path":"data/prices.xlsx","title":"价格表","kind":"spreadsheet","version":"\(version)","createdAt":"2026-10-26T01:00:00Z","updatedAt":"2026-10-26T01:00:00Z"}
        """
        let document = try JSONDecoder().decode(AlfredDocument.self, from: Data(json.utf8))
        XCTAssertEqual(document.kind.rawValue, "spreadsheet")
        XCTAssertNil(document.taskId)
    }
}
