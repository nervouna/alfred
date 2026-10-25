import AlfredKit
import Foundation
import XCTest

final class CommandFixtureTests: XCTestCase {
    func testEveryCommandFixtureRoundTripsToTheSameJSON() throws {
        let files = try Fixtures.jsonFiles(in: "commands")
        XCTAssertGreaterThanOrEqual(files.count, 2, "one command fixture per command type")
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
}
