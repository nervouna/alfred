import AlfredKit
import Foundation
import XCTest

final class PairingFixtureTests: XCTestCase {
    func testThePairingFixtureDecodesItsFields() throws {
        let data = try Data(contentsOf: Fixtures.directory.appending(path: "pairing/pairing.json"))
        let pairing = try JSONDecoder().decode(Pairing.self, from: data)
        XCTAssertEqual(pairing.server.absoluteString, "https://alfred.example.com")
        XCTAssertEqual(pairing.access.clientId, "example-service-token.access")
        XCTAssertEqual(pairing.access.clientSecret, "example-client-secret-not-real")
        XCTAssertEqual(pairing.device.id, "k7m2qa")
        XCTAssertEqual(pairing.device.token, "EXAMPLE-DEVICE-TOKEN-NOT-REAL-0123456789abc")
    }

    func testEveryPairingInvalidFixtureIsRejected() throws {
        let files = try Fixtures.jsonFiles(in: "invalid").filter { $0.lastPathComponent.hasPrefix("pairing-") }
        XCTAssertGreaterThanOrEqual(files.count, 3, "http server, version 2 and a server with a path")
        for file in files {
            XCTAssertThrowsError(
                try JSONDecoder().decode(Pairing.self, from: Data(contentsOf: file)),
                file.lastPathComponent
            )
        }
    }
}
