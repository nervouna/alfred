import AlfredKit
import Foundation
import XCTest

final class RequestFixtureTests: XCTestCase {
    func testPushRegistrationEncodesToItsFixture() throws {
        let file = Fixtures.directory.appending(path: "requests/push-registration.json")
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: String])
        let registration = PushRegistration(token: try XCTUnwrap(fixture["token"]), environment: .development)
        let encoded = try JSONEncoder().encode(registration)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: String])
        XCTAssertEqual(json, fixture)
    }
}
