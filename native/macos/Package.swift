// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "VLMKitNative", platforms: [.macOS(.v14)],
    products: [.executable(name: "VLMKitNativeAgent", targets: ["VLMKitNativeAgent"]),
               .executable(name: "VLMKitAXFixture", targets: ["VLMKitAXFixture"])],
    targets: [.executableTarget(name: "VLMKitNativeAgent"), .executableTarget(name: "VLMKitAXFixture"),
              .testTarget(name: "VLMKitNativeTests", dependencies: ["VLMKitNativeAgent"])]
)
