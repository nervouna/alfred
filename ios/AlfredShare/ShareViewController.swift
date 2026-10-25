import UIKit

/// Completes the share request at once. Sending to Alfred comes with a later C1 issue.
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        extensionContext?.completeRequest(returningItems: nil)
    }
}
