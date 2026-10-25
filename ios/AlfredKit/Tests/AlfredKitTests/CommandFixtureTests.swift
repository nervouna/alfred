import AlfredKit
import Foundation
import XCTest

final class CommandFixtureTests: XCTestCase {
    func testEveryCommandFixtureRoundTripsToTheSameJSON() throws {
        let files = try Fixtures.jsonFiles(in: "commands")
        XCTAssertGreaterThanOrEqual(files.count, 3, "one command fixture per command type")
        for file in files {
            let name = file.lastPathComponent
            do {
                let data = try Data(contentsOf: file)
                let command = try JSONDecoder().decode(Command.self, from: data)
                let encoded = try JSONEncoder().encode(command)
                let expected = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? NSDictionary)
                let actual = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? NSDictionary)
                XCTAssertTrue(actual.isEqual(expected), "\(name) re-encodes to \(actual), not \(expected)")
            } catch {
                XCTFail("\(name) does not round trip: \(error)")
            }
        }
    }

    func testCommandCasesCarryTheirFields() throws {
        let send = try JSONDecoder().decode(
            Command.self,
            from: Data(#"{"type":"message.send","clientId":"c-7f3a9e","text":"帮我查一下 VPS 价格"}"#.utf8)
        )
        XCTAssertEqual(send, .messageSend(clientId: "c-7f3a9e", text: "帮我查一下 VPS 价格"))
        let stop = try JSONDecoder().decode(Command.self, from: Data(#"{"type":"run.stop","runId":"k7m2qa"}"#.utf8))
        XCTAssertEqual(stop, .runStop(runId: "k7m2qa"))
    }

    func testQuestionAnswerCarriesTheQuestionIdAndItsAnswers() throws {
        let command = try decodeCommand("commands/question-answer.json")
        XCTAssertEqual(
            command,
            .questionAnswer(
                questionId: "q-8f2a41c0",
                answers: ["报告用哪种格式？": "短表格", "要对比哪些供应商？": "Hetzner, Vultr"]
            )
        )
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(command)) as? [String: Any])
        XCTAssertEqual(json["type"] as? String, "question.answer")
        XCTAssertEqual(json["questionId"] as? String, "q-8f2a41c0")
        XCTAssertEqual((json["answers"] as? [String: String])?["报告用哪种格式？"], "短表格")
    }

    func testMessageSendWithFilesCarriesThem() throws {
        let withText = try decodeCommand("commands/message-send-files.json")
        guard case let .messageSend(clientId, text, files) = withText else {
            return XCTFail("expected message.send, got \(withText)")
        }
        XCTAssertEqual(clientId, "c-7f3a9f")
        XCTAssertEqual(text, "这张图里是什么？")
        XCTAssertEqual(files.map(\.path), ["inbox/2026-10-25/IMG_0413.jpg"])
        XCTAssertEqual(files.map(\.kind?.rawValue), ["image"])

        let filesOnly = try decodeCommand("commands/message-send-files-only.json")
        guard case let .messageSend(_, emptyText, pdfs) = filesOnly else {
            return XCTFail("expected message.send, got \(filesOnly)")
        }
        XCTAssertEqual(emptyText, "")
        XCTAssertEqual(pdfs.map(\.path), ["inbox/2026-10-25/quote.pdf"])
    }

    func testMessageSendWithoutFilesHasNoFilesKeyWhenEncoded() throws {
        let command = try decodeCommand("commands/message-send.json")
        guard case let .messageSend(_, _, files) = command else {
            return XCTFail("expected message.send, got \(command)")
        }
        XCTAssertEqual(files.count, 0)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(command)) as? [String: Any])
        XCTAssertNil(json["files"])
    }

    private func decodeCommand(_ name: String) throws -> Command {
        try JSONDecoder().decode(Command.self, from: Data(contentsOf: Fixtures.directory.appending(path: name)))
    }
}
