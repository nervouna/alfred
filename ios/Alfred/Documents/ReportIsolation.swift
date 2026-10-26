import SwiftUI
import WebKit

/// How an HTML report is kept away from the app, as the workbench's `REPORT_CSP` does for the web: the report's
/// own script and style run, so charts draw, and nothing loads from anywhere.
///
/// - No data survives the report: the web view uses a non-persistent data store, so it shares no cookies or
///   storage with anything.
/// - It has no script message handler, so the page cannot call into the app and cannot reach its tokens, which
///   live in the keychain and in `AlfredClient`, outside the web view.
/// - A content rule list blocks every load but the document itself and `data:` URLs: no network, no scripts, images
///   or fonts from elsewhere.
/// - The navigation delegate cancels every navigation after the first load, so a link, a form or a script cannot
///   take the web view elsewhere.
/// - The page loads from a string with a `nil` base URL, so it has no origin of Alfred's.
@MainActor
enum ReportIsolation {
    static let ruleListIdentifier = "io.alfred.report-isolation"

    /// Block everything, then take the block back for the document itself (`about:blank`, what a string loads as)
    /// and for `data:` URLs.
    static let ruleListJSON = """
    [
      {"trigger": {"url-filter": ".*"}, "action": {"type": "block"}},
      {"trigger": {"url-filter": "^data:"}, "action": {"type": "ignore-previous-rules"}},
      {"trigger": {"url-filter": "^about:blank$"}, "action": {"type": "ignore-previous-rules"}}
    ]
    """

    struct RuleListUnavailable: Error {}

    static func compileRuleList() async throws -> WKContentRuleList {
        let list = try await WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: ruleListIdentifier,
            encodedContentRuleList: ruleListJSON
        )
        guard let list else { throw RuleListUnavailable() }
        return list
    }

    static func configuration(ruleList: WKContentRuleList) -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.add(ruleList)
        return configuration
    }

    /// What the web view loads for a file: HTML as it is, and an SVG inside a page that fits it to the screen.
    static func document(for text: String, isSVG: Bool) -> String {
        guard isSVG else { return text }
        return """
        <!doctype html><html><head><meta charset="utf-8">\
        <meta name="viewport" content="width=device-width, initial-scale=1">\
        <style>html, body { margin: 0; } svg { max-width: 100%; height: auto; }</style>\
        </head><body>\(text)</body></html>
        """
    }
}

/// Lets the web view load the report once, then cancels every navigation.
@MainActor
final class ReportNavigationPolicy {
    private var expectsLoad = false

    /// Call right before loading the report.
    func expectLoad() {
        expectsLoad = true
    }

    /// The report's own load is allowed once, and only as the blank document a string loads as. A link, a form, a
    /// script or a redirect after that, or one that comes first, is cancelled.
    func decide(for url: URL?) -> WKNavigationActionPolicy {
        guard expectsLoad, url?.scheme == "about" else { return .cancel }
        expectsLoad = false
        return .allow
    }
}

@MainActor
final class ReportNavigationDelegate: NSObject, WKNavigationDelegate {
    let policy = ReportNavigationPolicy()
    /// The navigations it cancelled.
    private(set) var cancelled: [URL?] = []

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        let url = navigationAction.request.url
        let decision = policy.decide(for: url)
        if decision == .cancel { cancelled.append(url) }
        return decision
    }
}

/// The isolated web view for one report.
struct ReportWebView: UIViewRepresentable {
    let html: String
    let ruleList: WKContentRuleList

    func makeCoordinator() -> ReportNavigationDelegate {
        ReportNavigationDelegate()
    }

    func makeUIView(context: Context) -> WKWebView {
        let webView = WKWebView(frame: .zero, configuration: ReportIsolation.configuration(ruleList: ruleList))
        webView.navigationDelegate = context.coordinator
        // A long press on a link would otherwise preview it, which loads it.
        webView.allowsLinkPreview = false
        context.coordinator.policy.expectLoad()
        webView.loadHTMLString(html, baseURL: nil)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}
}
