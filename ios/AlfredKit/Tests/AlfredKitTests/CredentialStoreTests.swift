@testable import AlfredKit
import Foundation
import Security
import XCTest

final class CredentialStoreTests: XCTestCase {
    func testCredentialsTakeTheirFieldsFromThePairingAndRoundTripAsJSON() throws {
        let credentials = try pairedCredentials()
        XCTAssertEqual(credentials.server.absoluteString, "https://alfred.example.com")
        XCTAssertEqual(credentials.accessClientId, "example-service-token.access")
        XCTAssertEqual(credentials.accessClientSecret, "example-client-secret-not-real")
        XCTAssertEqual(credentials.deviceId, "k7m2qa")
        XCTAssertEqual(credentials.deviceToken, "EXAMPLE-DEVICE-TOKEN-NOT-REAL-0123456789abc")
        let decoded = try JSONDecoder().decode(Credentials.self, from: JSONEncoder().encode(credentials))
        XCTAssertEqual(decoded, credentials)
    }

    func testTheInMemoryStoreSavesLoadsAndDeletes() throws {
        let store = InMemoryCredentialStore()
        XCTAssertNil(try store.load())
        let credentials = try pairedCredentials()
        try store.save(credentials)
        XCTAssertEqual(try store.load(), credentials)
        try store.delete()
        XCTAssertNil(try store.load())
    }

    /// The keychain queries are built without touching the keychain: only their dictionaries are inspected.
    func testTheKeychainQueriesNameTheItemItsAccessGroupAndItsAccessibility() {
        let store = KeychainCredentialStore(service: "com.example.alfred", accessGroup: "TEAM.com.example.alfred")
        let query = store.itemQuery()
        XCTAssertEqual(query[kSecClass as String] as? String, kSecClassGenericPassword as String)
        XCTAssertEqual(query[kSecAttrService as String] as? String, "com.example.alfred")
        XCTAssertEqual(query[kSecAttrAccount as String] as? String, "device")
        XCTAssertEqual(query[kSecAttrAccessGroup as String] as? String, "TEAM.com.example.alfred")
        XCTAssertNil(query[kSecValueData as String])

        let value = Data("{}".utf8)
        let add = store.newItemQuery(data: value)
        XCTAssertEqual(add[kSecAttrService as String] as? String, "com.example.alfred")
        XCTAssertEqual(add[kSecAttrAccount as String] as? String, "device")
        XCTAssertEqual(add[kSecAttrAccessGroup as String] as? String, "TEAM.com.example.alfred")
        XCTAssertEqual(add[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlock as String)
        XCTAssertEqual(add[kSecValueData as String] as? Data, value)
    }

    func testTheKeychainQueriesOmitTheAccessGroupWhenThereIsNone() {
        let store = KeychainCredentialStore(service: "com.example.alfred")
        XCTAssertNil(store.itemQuery()[kSecAttrAccessGroup as String])
        XCTAssertNil(store.newItemQuery(data: Data()) [kSecAttrAccessGroup as String])
    }
}
