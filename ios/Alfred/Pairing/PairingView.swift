import SwiftUI

/// The first screen: pair by scanning the QR code, or by pasting the pairing. The paste button needs no paste
/// prompt, and it is the way in on the simulator, which has no camera.
struct PairingView: View {
    let model: AppModel
    @State private var isScanning = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Spacer()
                Image(systemName: "qrcode.viewfinder")
                    .font(.system(size: 72))
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
                if QRScannerView.isAvailable {
                    Button("扫描二维码", systemImage: "camera") { isScanning = true }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.isPairing)
                }
                PasteButton(payloadType: String.self) { strings in
                    guard let text = strings.first else { return }
                    Task { @MainActor in await model.pair(with: text) }
                }
                .buttonBorderShape(.capsule)
                .disabled(model.isPairing)
                .accessibilityLabel("粘贴配对信息")
                if model.isPairing {
                    ProgressView()
                }
                if let failure = model.pairingFailure {
                    Text(failure.message)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("pairing.error")
                }
                Spacer()
            }
            .padding()
            .frame(maxWidth: .infinity)
            .navigationTitle("配对")
        }
        .sheet(isPresented: $isScanning) {
            QRScannerView { code in
                isScanning = false
                Task { @MainActor in await model.pair(with: code) }
            }
            .ignoresSafeArea()
        }
    }
}
