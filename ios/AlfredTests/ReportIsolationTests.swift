import WebKit
import XCTest

@testable import Alfred

/// The isolation of the web view an HTML report runs in. The policy and the rules are checked as values, and the
/// rest against a real `WKWebView`: the report's script runs, and nothing but the document and `data:` URLs loads.
@MainActor
final class ReportIsolationTests: XCTestCase {
    // MARK: The navigation policy

    func testEveryNavigationAfterTheFirstLoadIsCancelled() throws {
        let policy = ReportNavigationPolicy()
        policy.expectLoad()
        XCTAssertEqual(policy.decide(for: URL(string: "about:blank")), .allow)

        XCTAssertEqual(policy.decide(for: try XCTUnwrap(URL(string: "https://example.com/x"))), .cancel)
        XCTAssertEqual(policy.decide(for: try XCTUnwrap(URL(string: "http://example.com/"))), .cancel)
        XCTAssertEqual(policy.decide(for: try XCTUnwrap(URL(string: "mailto:a@example.com"))), .cancel)
        XCTAssertEqual(policy.decide(for: try XCTUnwrap(URL(string: "tel:12345"))), .cancel)
        XCTAssertEqual(policy.decide(for: try XCTUnwrap(URL(string: "data:text/html,hi"))), .cancel)
        XCTAssertEqual(policy.decide(for: URL(string: "about:blank")), .cancel, "the document does not load a second time")
        XCTAssertEqual(policy.decide(for: nil), .cancel)
    }

    func testNothingIsAllowedBeforeTheReportIsExpected() throws {
        let policy = ReportNavigationPolicy()
        XCTAssertEqual(policy.decide(for: URL(string: "about:blank")), .cancel)
        XCTAssertEqual(policy.decide(for: try XCTUnwrap(URL(string: "https://example.com/"))), .cancel)
    }

    func testTheFirstLoadHasToBeTheDocumentItself() throws {
        let policy = ReportNavigationPolicy()
        policy.expectLoad()
        XCTAssertEqual(policy.decide(for: try XCTUnwrap(URL(string: "https://example.com/"))), .cancel, "a link is no document")
        XCTAssertEqual(policy.decide(for: URL(string: "about:blank")), .allow, "the cancelled one did not use up the load")
    }

    // MARK: The content rule list

    private struct Rule: Decodable {
        struct Trigger: Decodable {
            let urlFilter: String
            enum CodingKeys: String, CodingKey { case urlFilter = "url-filter" }
        }
        struct Action: Decodable { let type: String }
        let trigger: Trigger
        let action: Action
    }

    func testTheRulesBlockEverythingThenAllowTheDocumentAndDataURLs() throws {
        let rules = try JSONDecoder().decode([Rule].self, from: Data(ReportIsolation.ruleListJSON.utf8))
        XCTAssertEqual(rules.first?.trigger.urlFilter, ".*")
        XCTAssertEqual(rules.first?.action.type, "block")
        let allowed = rules.dropFirst()
        XCTAssertEqual(allowed.map(\.action.type), Array(repeating: "ignore-previous-rules", count: allowed.count))
        XCTAssertEqual(Set(allowed.map(\.trigger.urlFilter)), ["^data:", "^about:blank$"])
    }

    func testTheRuleListCompiles() async throws {
        let list = try await ReportIsolation.compileRuleList()
        XCTAssertEqual(list.identifier, ReportIsolation.ruleListIdentifier)
    }

    // MARK: The document

    func testAnSVGIsWrappedInAPageAndHTMLIsLoadedAsItIs() {
        let svg = #"<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>"#
        let wrapped = ReportIsolation.document(for: svg, isSVG: true)
        XCTAssertTrue(wrapped.hasPrefix("<!doctype html>"))
        XCTAssertTrue(wrapped.contains(svg))
        XCTAssertEqual(ReportIsolation.document(for: "<p>hi</p>", isSVG: false), "<p>hi</p>")
    }

    // MARK: The configuration

    func testTheConfigurationHasNoStoredDataAndNoBridge() async throws {
        let configuration = ReportIsolation.configuration(ruleList: try await ReportIsolation.compileRuleList())
        XCTAssertFalse(configuration.websiteDataStore.isPersistent)
        XCTAssertTrue(configuration.defaultWebpagePreferences.allowsContentJavaScript, "charts have to draw")
        XCTAssertTrue(configuration.userContentController.userScripts.isEmpty)
        XCTAssertFalse(configuration.preferences.javaScriptCanOpenWindowsAutomatically)
    }

    func testTwoReportsDoNotShareADataStore() async throws {
        let list = try await ReportIsolation.compileRuleList()
        let first = ReportIsolation.configuration(ruleList: list)
        let second = ReportIsolation.configuration(ruleList: list)
        XCTAssertFalse(first.websiteDataStore === second.websiteDataStore)
        XCTAssertFalse(first.websiteDataStore === WKWebsiteDataStore.default())
    }

    // MARK: A real web view

    private static let page = """
    <!doctype html><meta charset="utf-8">
    <img id="blocked" src="probe://example.com/x.png">
    <img id="data" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
    <p id="out">waiting</p>
    <a id="link" href="https://example.com/next">next</a>
    <script>document.getElementById('out').textContent = '你好 ' + (1 + 1);</script>
    """

    /// What the page can see of itself once it has loaded.
    private struct Seen: Decodable {
        let text: String
        let dataImageWidth: Int
        let bridge: String
        let url: String
    }

    private func seen(by webView: WKWebView) async throws -> Seen {
        let script = """
        JSON.stringify({
          text: document.getElementById('out').textContent,
          dataImageWidth: document.getElementById('data').naturalWidth,
          bridge: typeof window.webkit,
          url: location.href
        })
        """
        let result = try await webView.evaluateJavaScript(script)
        let json = try XCTUnwrap(result as? String)
        return try JSONDecoder().decode(Seen.self, from: Data(json.utf8))
    }

    /// Loads the page and returns once its script has run and the document, images included, has finished loading.
    private func loadPage(in webView: WKWebView) async throws {
        webView.loadHTMLString(Self.page, baseURL: nil)
        let ready = "document.readyState === 'complete' && document.getElementById('out') !== null && document.getElementById('out').textContent !== 'waiting'"
        for _ in 0..<1000 {
            if (try? await webView.evaluateJavaScript(ready)) as? Bool == true { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("the page never finished loading")
    }

    private func makeWebView(_ configuration: WKWebViewConfiguration) -> WKWebView {
        WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 480), configuration: configuration)
    }

    func testTheReportRunsAndLoadsNothingButItselfAndDataURLs() async throws {
        // Control: with no rules the page's first image does reach the loader, so the probe works.
        let controlProbe = ProbeSchemeHandler()
        let plain = WKWebViewConfiguration()
        plain.setURLSchemeHandler(controlProbe, forURLScheme: "probe")
        try await loadPage(in: makeWebView(plain))
        XCTAssertEqual(controlProbe.requested.count, 1, "the probe should see the image request when nothing blocks it")

        let probe = ProbeSchemeHandler()
        let configuration = ReportIsolation.configuration(ruleList: try await ReportIsolation.compileRuleList())
        configuration.setURLSchemeHandler(probe, forURLScheme: "probe")
        let webView = makeWebView(configuration)
        try await loadPage(in: webView)

        let page = try await seen(by: webView)
        XCTAssertEqual(page.text, "你好 2", "the report's inline script runs")
        XCTAssertEqual(page.dataImageWidth, 1, "a data: image loads")
        XCTAssertEqual(probe.requested, [], "an image from another URL never reaches the loader")
        XCTAssertEqual(page.bridge, "undefined", "the page has no way to message the app")
        XCTAssertEqual(page.url, "about:blank")
    }

    func testALinkOrAScriptCannotLeaveTheDocument() async throws {
        let configuration = ReportIsolation.configuration(ruleList: try await ReportIsolation.compileRuleList())
        let webView = makeWebView(configuration)
        let delegate = ReportNavigationDelegate()
        webView.navigationDelegate = delegate
        delegate.policy.expectLoad()
        try await loadPage(in: webView)
        XCTAssertEqual(delegate.cancelled, [], "the first load is the document")

        _ = try await webView.evaluateJavaScript("document.getElementById('link').click(); null")
        _ = try await webView.evaluateJavaScript("location.href = 'https://example.com/script'; null")
        _ = try await webView.evaluateJavaScript("window.open('https://example.com/popup'); null")
        try await Task.sleep(for: .milliseconds(500))

        XCTAssertEqual(delegate.cancelled.compactMap { $0?.path }.sorted(), ["/next", "/script"])
        let page = try await seen(by: webView)
        XCTAssertEqual(page.url, "about:blank")
        XCTAssertEqual(webView.url?.scheme, "about")
    }
}

/// Records the requests a page makes for a custom scheme, and fails them.
@MainActor
private final class ProbeSchemeHandler: NSObject, WKURLSchemeHandler {
    private(set) var requested: [URL] = []

    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        if let url = urlSchemeTask.request.url { requested.append(url) }
        urlSchemeTask.didFailWithError(URLError(.cancelled))
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {}
}
