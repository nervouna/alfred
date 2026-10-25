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

    func testTheLoopbackPairingFixtureDecodes() throws {
        let data = try Data(contentsOf: Fixtures.directory.appending(path: "pairing/pairing-loopback.json"))
        let pairing = try JSONDecoder().decode(Pairing.self, from: data)
        XCTAssertEqual(pairing.server.absoluteString, "http://127.0.0.1:8787")
    }

    func testAnHTTPServerIsAcceptedOnlyOnLoopback() throws {
        let base = try String(contentsOf: Fixtures.directory.appending(path: "pairing/pairing.json"), encoding: .utf8)
        func decode(_ server: String) throws -> Pairing {
            let json = base.replacingOccurrences(of: "https://alfred.example.com", with: server)
            return try JSONDecoder().decode(Pairing.self, from: Data(json.utf8))
        }
        for server in ["http://127.0.0.1:18900", "http://localhost:8787", "http://localhost"] {
            XCTAssertEqual(try decode(server).server.absoluteString, server)
        }
        for server in ["http://192.168.1.2:8787", "http://127.0.0.2:8787", "http://localhost.example.com:8787", "http://[::1]:8787", "http://alfred.example.com"] {
            XCTAssertThrowsError(try decode(server), server)
        }
    }

    func testEveryPairingInvalidFixtureIsRejected() throws {
        let files = try Fixtures.jsonFiles(in: "invalid").filter { $0.lastPathComponent.hasPrefix("pairing-") }
        XCTAssertGreaterThanOrEqual(files.count, 4, "http server, a LAN http server, version 2 and a server with a path")
        for file in files {
            XCTAssertThrowsError(
                try JSONDecoder().decode(Pairing.self, from: Data(contentsOf: file)),
                file.lastPathComponent
            )
        }
    }
}
