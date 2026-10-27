import AlfredKit
import SwiftUI
import UIKit
import XCTest

@testable import Alfred

/// The chat's header: a bar as tall as the system's inline navigation bar, with Alfred's avatar outside it, 24 pt of the
/// avatar below the bar's bottom edge.
///
/// The bar's edge effect and what the phone shows of it are for the UI tests and the owner's eyes: a snapshot of a hosted
/// view does not draw the effect, so nothing here judges it. What is checked here is what the effect depends on, the
/// bar's height and where the avatar is drawn.
@MainActor
final class ChatHeaderTests: XCTestCase {
    private var windows: [UIWindow] = []

    override func tearDown() async throws {
        windows.forEach { $0.isHidden = true }
        windows = []
    }

    // MARK: The bar's height

    /// The bar's height is not a number of ours: it is what UIKit gives the system's own inline bar on this device, and
    /// it is the height of a real inline bar, which is checked here against two that are on screen.
    func testTheBarIsAsTallAsTheSystemsInlineNavigationBar() async throws {
        // A UIKit navigation controller's.
        let root = UIViewController()
        root.title = "x"
        let controller = UINavigationController(rootViewController: root)
        let window = try show(controller)
        await settle()
        XCTAssertEqual(ChatHeader.barHeight, controller.navigationBar.frame.height, accuracy: 0.5, "against UINavigationController's bar")
        XCTAssertGreaterThan(ChatHeader.barHeight, 0)
        window.rootViewController = nil

        // The one a SwiftUI navigation stack draws, with an inline title as on the screens the chat opens.
        let stack = UIHostingController(rootView: NavigationStack {
            List { Text("a") }
                .navigationTitle("x")
                .navigationBarTitleDisplayMode(.inline)
        })
        window.rootViewController = stack
        await settle()
        let bar = try XCTUnwrap(navigationBars(in: stack.view).first, "no navigation bar in the SwiftUI stack")
        XCTAssertEqual(ChatHeader.barHeight, bar.convert(bar.bounds, to: nil).height, accuracy: 0.5, "against a SwiftUI stack's inline bar")
    }

    /// The avatar's bottom edge is `hang` (24 pt) below the bar's, and its top edge is above that by the rest of its
    /// diameter: 48 pt above the bar's bottom edge.
    func testTheAvatarsLowerThirdIsBelowTheBar() {
        XCTAssertEqual(AvatarMetrics.diameter, 72)
        XCTAssertEqual(AvatarMetrics.hang, 24)
        let barTop: CGFloat = 62
        let barBottom = barTop + ChatHeader.barHeight
        let avatarTop = barTop + ChatHeader.avatarOffset
        XCTAssertEqual(avatarTop + AvatarMetrics.diameter - barBottom, 24, accuracy: 0.001)
        XCTAssertEqual(barBottom - avatarTop, 48, accuracy: 0.001)
    }

    // MARK: The chat on screen

    /// The real chat in a window of the phone's size: the avatar, found by its ring on the dark background, is 72 pt
    /// across, and its top edge is where the bar's bottom edge less 48 pt puts it, under the top safe area. The capsule
    /// that says `连接中…` does not move it, which it would if the capsule made the bar taller.
    func testTheAvatarHangsBelowTheBarWhetherOrNotTheChatIsConnecting() async throws {
        let connecting = try await avatarRows(connected: false)
        let connected = try await avatarRows(connected: true)

        let window = try XCTUnwrap(windows.first)
        XCTAssertGreaterThan(window.safeAreaInsets.top, 0, "the window has a top safe area for the bar to sit under")
        let barBottom = window.safeAreaInsets.top + ChatHeader.barHeight
        for (name, rows) in [("connecting", connecting), ("connected", connected)] {
            XCTAssertEqual(rows.top, barBottom - 48, accuracy: 2.5, "the avatar's top edge, \(name)")
            XCTAssertEqual(rows.bottom, barBottom + 24, accuracy: 2.5, "the avatar's bottom edge, \(name)")
        }
        XCTAssertEqual(connecting.top, connected.top, accuracy: 0.5, "the connecting capsule moved the avatar")
        XCTAssertEqual(connecting.bottom, connected.bottom, accuracy: 0.5, "the connecting capsule moved the avatar")
    }

    /// The rows the avatar occupies in a snapshot of the chat, in points from the top of the window.
    private func avatarRows(connected: Bool) async throws -> (top: CGFloat, bottom: CGFloat) {
        // A paired model on a stub server, with an event stream that says it is connected, or never does.
        let server = StubServer { _ in StubReply(status: 404) }
        let model = AppModel(
            store: InMemoryCredentialStore(try server.credentials()),
            session: server.session,
            openStream: { _, _ in AsyncStream { if connected { $0.yield(.connected) } } }
        )
        addTeardownBlock { @MainActor in
            model.background()
            withExtendedLifetime(server) {}
        }
        model.foreground()
        for _ in 0..<100 where model.isConnected != connected { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertEqual(model.isConnected, connected)
        let host = UIHostingController(rootView: ChatView(model: model))
        host.overrideUserInterfaceStyle = .dark
        let window = try show(host)
        window.overrideUserInterfaceStyle = .dark
        await settle(1000)

        let bounds = window.bounds
        let scale = 3 as CGFloat
        let format = UIGraphicsImageRendererFormat()
        format.scale = scale
        let image = UIGraphicsImageRenderer(bounds: bounds, format: format).image { _ in
            window.drawHierarchy(in: bounds, afterScreenUpdates: true)
        }
        return try XCTUnwrap(Self.rows(of: image, around: bounds.midX, scale: scale), "no avatar in the snapshot")
    }

    /// The first run of rows, in a thin column about `x`, whose pixels are not the black of the dark background.
    private static func rows(of image: UIImage, around x: CGFloat, scale: CGFloat) -> (top: CGFloat, bottom: CGFloat)? {
        guard let cgImage = image.cgImage else { return nil }
        let width = cgImage.width
        let height = cgImage.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        guard let context = CGContext(
            data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
        let column = Int(x * scale)
        func isAvatar(row: Int) -> Bool {
            (column - 6...column + 6).contains { c in
                let i = (row * width + c) * 4
                return Int(pixels[i]) + Int(pixels[i + 1]) + Int(pixels[i + 2]) > 60
            }
        }
        guard let first = (0..<height).first(where: isAvatar) else { return nil }
        var last = first
        while last + 1 < height, isAvatar(row: last + 1) { last += 1 }
        return (CGFloat(first) / scale, CGFloat(last + 1) / scale)
    }

    // MARK: Windows

    /// Puts `controller` in a window the size of the phone's screen.
    private func show(_ controller: UIViewController) throws -> UIWindow {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first, "no window scene")
        let window = UIWindow(windowScene: scene)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        windows.append(window)
        return window
    }

    private func settle(_ milliseconds: Int = 600) async {
        try? await Task.sleep(for: .milliseconds(milliseconds))
    }

    private func navigationBars(in view: UIView) -> [UINavigationBar] {
        let own = (view as? UINavigationBar).map { [$0] } ?? []
        return own + view.subviews.flatMap(navigationBars(in:))
    }
}
