import SwiftUI
import UIKit

/// Hosts the sheet that sends what was shared to Alfred. The decisions are in `ShareModel`; this connects it to the
/// share request.
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        let model = ShareModel(store: AppKeychain.store(), loader: { try await SharedContentLoader.load(from: items) })
        let sheet = ShareView(
            model: model,
            finish: { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) },
            cancel: { [weak self] in
                model.discard()
                self?.extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
            }
        )
        let host = UIHostingController(rootView: sheet)
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }
}
