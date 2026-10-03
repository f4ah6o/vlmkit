import XCTest
import ApplicationServices
@testable import VLMKitNativeAgent
final class MappingTests: XCTestCase {
    func testRolesPreserveUnknownAndUseParentAndSubrole() {
        for (platform, role) in roles { XCTAssertEqual(normalizedRole(platform, nil, nil), role) }
        XCTAssertEqual(normalizedRole("AXWindow", "AXDialog", nil), "dialog")
        XCTAssertEqual(normalizedRole("AXRow", nil, "list"), "listitem")
        XCTAssertEqual(normalizedRole("AXRow", nil, "group"), "AXRow")
        XCTAssertEqual(normalizedRole("AXMystery", "AXCustom", nil), "AXMystery")
    }
    func testScalarValues() {
        XCTAssertEqual(scalar("Ada" as CFString), "Ada")
        XCTAssertEqual(scalar(NSNumber(value: 42)), "42")
        XCTAssertEqual(scalar(kCFBooleanTrue), "true")
        XCTAssertEqual(scalar(kCFBooleanFalse), "false")
        XCTAssertNil(scalar(["complex"] as CFArray))
    }
    func testGlobalCoordinatesBecomeLocalAtAnyDisplayOrigin() {
        for origin in [CGPoint(x: 150, y: 80), CGPoint(x: -1200, y: -900)] {
            let frame = CGRect(x: origin.x + 30, y: origin.y + 50, width: 100, height: 36)
            XCTAssertEqual(rectJSON(frame.offsetBy(dx: -origin.x, dy: -origin.y)),
                           ["left": 30, "top": 50, "width": 100, "height": 36])
        }
    }
}
extension MappingTests {
    func testCheckboxValueMapping() {
        XCTAssertEqual(checkedState("AXCheckBox", NSNumber(value: 1)), true)
        XCTAssertEqual(checkedState("AXCheckBox", NSNumber(value: 0)), false)
        XCTAssertNil(checkedState("AXCheckBox", NSNumber(value: 2)))
        XCTAssertNil(checkedState("AXSlider", NSNumber(value: 1)))
    }
    @MainActor func testPassiveDoctorAndPermissionErrors() async throws {
        let agent = Agent()
        agent.accessibilityTrusted = { false }
        agent.screenAuthorized = { false }
        var prompts = 0
        agent.requestAccessibility = { prompts += 1 }
        agent.requestScreenCapture = { prompts += 1 }
        let result = try await agent.dispatch("doctor", ["prompt": false]) as! [String: Any]
        XCTAssertEqual(prompts, 0)
        XCTAssertEqual((result["accessibility"] as! [String: Bool])["trusted"], false)
        XCTAssertThrowsError(try agent.accessibility()) { XCTAssertEqual(($0 as? NativeError)?.code, "NATIVE_PERMISSION_ACCESSIBILITY") }
        XCTAssertThrowsError(try agent.screenPermission()) { XCTAssertEqual(($0 as? NativeError)?.code, "NATIVE_PERMISSION_SCREEN_CAPTURE") }
        _ = try await agent.dispatch("doctor", ["prompt": true])
        XCTAssertEqual(prompts, 2)
    }
}

extension MappingTests {
    func testScreenshotPixelTransformUsesOneScaleAndGlobalOrigin() throws {
        let transform = NativeCoordinateTransform(
            globalWindowOriginPoints: CGPoint(x: -1200, y: 80),
            logicalToPixelScale: 2
        )
        let global = try transform.globalPoint(xPx: 200, yPx: 72)
        XCTAssertEqual(global.x, -1100)
        XCTAssertEqual(global.y, 116)
        XCTAssertEqual(transform.localPoint(global), CGPoint(x: 100, y: 36))
    }

    func testActionEvidenceRedactsTypedText() {
        let record = safeActionEvidence(
            action: [
                "kind": "typeText",
                "mode": "semantic",
                "text": "POISON_DO_NOT_LOG",
                "locator": ["by": "stable-id", "value": "fixture.name"]
            ],
            mode: "semantic",
            target: ["identifier": "fixture.name", "role": "textfield"],
            point: nil
        )
        let action = record["action"] as! [String: Any]
        XCTAssertNil(action["text"])
        XCTAssertEqual(action["textLength"] as? Int, "POISON_DO_NOT_LOG".utf16.count)
    }

    func testDuplicateRoleNameLocatorIsAmbiguousBeforeAction() throws {
        let root = AXUIElementCreateSystemWide()
        XCTAssertThrowsError(
            try resolveLocator(root, origin: .zero, locator: ["by": "role-name", "role": "button", "name": "missing"])
        ) {
            XCTAssertEqual(($0 as? NativeError)?.code, "NATIVE_LOCATOR_NOT_FOUND")
        }
    }
}
