import PDFKit
import QuickLook
import SwiftUI

/// A PDF, in PDFKit.
struct PDFFile: View {
    let url: URL
    @State private var document: PDFDocument?
    @State private var isUnreadable = false

    var body: some View {
        Group {
            if let document {
                PDFKitView(document: document)
                    .accessibilityIdentifier("viewer.pdf")
            } else if isUnreadable {
                ContentUnavailableView("无法打开这个 PDF", systemImage: "exclamationmark.triangle")
            } else {
                ProgressView()
            }
        }
        .task(id: url) {
            document = PDFDocument(url: url)
            isUnreadable = document == nil
        }
    }
}

private struct PDFKitView: UIViewRepresentable {
    let document: PDFDocument

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.document = document
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {}
}

/// An image the owner can pinch to zoom and double-tap.
struct ImageFile: View {
    let url: URL
    @State private var image: UIImage?
    @State private var isUnreadable = false

    var body: some View {
        Group {
            if let image {
                ZoomableImage(image: image)
                    .ignoresSafeArea(edges: .bottom)
                    .accessibilityElement()
                    .accessibilityLabel(url.lastPathComponent)
                    .accessibilityIdentifier("viewer.image")
            } else if isUnreadable {
                ContentUnavailableView("无法打开这张图片", systemImage: "exclamationmark.triangle")
            } else {
                ProgressView()
            }
        }
        .task(id: url) {
            image = UIImage(contentsOfFile: url.path)
            isUnreadable = image == nil
        }
    }
}

private struct ZoomableImage: UIViewRepresentable {
    let image: UIImage

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> FittingScrollView {
        let scrollView = FittingScrollView()
        scrollView.delegate = context.coordinator
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = 6
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.contentInsetAdjustmentBehavior = .never

        let imageView = UIImageView(image: image)
        imageView.contentMode = .scaleAspectFit
        scrollView.addSubview(imageView)
        scrollView.imageView = imageView
        context.coordinator.imageView = imageView

        let doubleTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.toggleZoom(_:)))
        doubleTap.numberOfTapsRequired = 2
        scrollView.addGestureRecognizer(doubleTap)
        return scrollView
    }

    func updateUIView(_ view: FittingScrollView, context: Context) {}

    @MainActor
    final class Coordinator: NSObject, UIScrollViewDelegate {
        weak var imageView: UIImageView?

        func viewForZooming(in scrollView: UIScrollView) -> UIView? {
            imageView
        }

        @objc func toggleZoom(_ gesture: UITapGestureRecognizer) {
            guard let scrollView = gesture.view as? UIScrollView, let imageView else { return }
            if scrollView.zoomScale > 1 {
                scrollView.setZoomScale(1, animated: true)
                return
            }
            let scale: CGFloat = 3
            let point = gesture.location(in: imageView)
            let size = CGSize(width: scrollView.bounds.width / scale, height: scrollView.bounds.height / scale)
            scrollView.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
        }
    }
}

/// A scroll view whose image fills it, aspect-fit, until the owner zooms.
private final class FittingScrollView: UIScrollView {
    var imageView: UIImageView?

    override func layoutSubviews() {
        super.layoutSubviews()
        guard zoomScale == 1, let imageView else { return }
        imageView.frame = bounds
        contentSize = bounds.size
    }
}

/// QuickLook for any file the other viewers do not take.
struct QuickLookView: UIViewControllerRepresentable {
    let url: URL

    func makeCoordinator() -> Coordinator {
        Coordinator(url: url)
    }

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {}

    @MainActor
    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL

        init(url: URL) {
            self.url = url
        }

        func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
            1
        }

        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem {
            url as NSURL
        }
    }
}
