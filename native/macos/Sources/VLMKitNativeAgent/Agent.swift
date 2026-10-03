import AppKit
import ApplicationServices
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers
import Security

let bundleID = "com.f4ah6o.vlmkit.native-agent"
func signing() -> [String: Any] {
    var code: SecCode?, staticCode: SecStaticCode?, info: CFDictionary?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let code,
          SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode,
          SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info) == errSecSuccess,
          let data = info as? [String: Any] else { return ["signed": false, "signingKind": "unsigned"] }
    let flags = (data[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value ?? 0
    let adhoc = flags & UInt32(0x2) != 0 // public kSecCodeSignatureAdhoc flag
    return ["signed": true, "signingKind": adhoc ? "adhoc" : "unknown"]
}
struct NativeWindow {
    let id: String
    let element: AXUIElement
    let frame: CGRect
    let title: String?
    let main: Bool
    let focused: Bool
    let minimized: Bool
    let capture: SCWindow?
    var visible: Bool { !minimized && capture?.isOnScreen == true }
    var json: [String: Any] {
        var out: [String: Any] = ["windowId": id, "axPath": id, "frameGlobalPoints": rectJSON(frame),
            "main": main, "focused": focused, "minimized": minimized, "onScreen": capture?.isOnScreen ?? false]
        if let title { out["title"] = title }
        if let capture { out["screenCaptureWindowId"] = capture.windowID }
        return out
    }
}
struct Session {
    let app: NSRunningApplication
    let launched: Bool
    var windows: [NativeWindow] = []
}
@MainActor
final class Agent {
    var sessions: [String: Session] = [:]
    var accessibilityTrusted: () -> Bool = { AXIsProcessTrusted() }
    var screenAuthorized: () -> Bool = { CGPreflightScreenCaptureAccess() }
    var requestAccessibility: () -> Void = { _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) }
    var requestScreenCapture: () -> Void = { _ = CGRequestScreenCaptureAccess() }
    func accessibility() throws {
        guard accessibilityTrusted() else { throw fail("NATIVE_PERMISSION_ACCESSIBILITY", "Allow VLMKitNativeAgent in System Settings > Privacy & Security > Accessibility.") }
    }
    func screenPermission() throws {
        guard screenAuthorized() else { throw fail("NATIVE_PERMISSION_SCREEN_CAPTURE", "Allow VLMKitNativeAgent in System Settings > Privacy & Security > Screen Recording.") }
    }
    func session(_ params: [String: Any]) throws -> (String, Session) {
        guard let id = params["sessionId"] as? String, let s = sessions[id] else { throw fail("NATIVE_TARGET_NOT_FOUND", "Unknown session.") }
        guard !s.app.isTerminated else { throw fail("NATIVE_TARGET_EXITED", "Target process exited.") }
        return (id, s)
    }
    func openTarget(_ target: [String: Any]) async throws -> [String: Any] {
        let by = target["by"] as? String
        var candidates: [NSRunningApplication] = []
        var url: URL?
        if by == "pid", let pid = target["pid"] as? Int, pid > 0, pid <= Int(Int32.max) {
            if let app = NSRunningApplication(processIdentifier: pid_t(pid)), !app.isTerminated { candidates = [app] }
        } else if by == "bundle-id", let id = target["bundleId"] as? String {
            candidates = NSRunningApplication.runningApplications(withBundleIdentifier: id)
            url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id)
        } else if by == "app-path", let path = target["appPath"] as? String {
            url = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
            candidates = NSWorkspace.shared.runningApplications.filter { $0.bundleURL?.standardizedFileURL.resolvingSymlinksInPath() == url }
        } else { throw fail("NATIVE_TARGET_NOT_FOUND", "Expected pid, bundle-id, or app-path target.") }
        if candidates.count > 1 { throw fail("NATIVE_TARGET_AMBIGUOUS", "Multiple matching processes; use a PID.") }
        var launched = false
        if candidates.isEmpty, target["launchIfNeeded"] as? Bool == true, let url {
            let config = NSWorkspace.OpenConfiguration()
            config.activates = false
            do {
                let app: NSRunningApplication = try await withCheckedThrowingContinuation { continuation in
                    NSWorkspace.shared.openApplication(at: url, configuration: config) { app, error in
                        if let app { continuation.resume(returning: app) }
                        else { continuation.resume(throwing: error ?? fail("NATIVE_TARGET_NOT_FOUND", "Launch failed.")) }
                    }
                }
                candidates = [app]; launched = true
            } catch { throw fail("NATIVE_TARGET_NOT_FOUND", "Cannot launch target: \(error)") }
        }
        guard let app = candidates.first else { throw fail("NATIVE_TARGET_NOT_FOUND", "No matching running application; opt into launchIfNeeded to launch.") }
        let ax = AXUIElementCreateApplication(app.processIdentifier)
        AXUIElementSetMessagingTimeout(ax, 2)
        let id = UUID().uuidString
        sessions[id] = Session(app: app, launched: launched)
        var result: [String: Any] = ["sessionId": id, "pid": app.processIdentifier, "launched": launched]
        if let bid = app.bundleIdentifier { result["bundleId"] = bid }
        if let path = app.bundleURL?.path { result["appPath"] = path }
        return result
    }
    func listWindows(_ params: [String: Any]) async throws -> [NativeWindow] {
        try accessibility(); try screenPermission()
        let (id, s) = try session(params)
        let application = AXUIElementCreateApplication(s.app.processIdentifier)
        AXUIElementSetMessagingTimeout(application, 2)
        var raw: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &raw)
        guard status == .success else {
            throw fail("NATIVE_AX_CANNOT_COMPLETE", "Cannot enumerate AX windows (\(status.rawValue)).")
        }
        let content: SCShareableContent
        do { content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false) }
        catch { throw fail("NATIVE_SCREENSHOT_FAILED", "Window enumeration failed: \(error)") }
        let reader = AXReader()
        let main = reader.value(application, kAXMainWindowAttribute)
        let focused = reader.value(application, kAXFocusedWindowAttribute)
        var windows: [NativeWindow] = []
        if ProcessInfo.processInfo.environment["VLMKIT_NATIVE_DEBUG"] == "1" { fputs("AX windows: \((raw as? [AXUIElement] ?? []).count)\n", stderr) }
        for (i, element) in (raw as? [AXUIElement] ?? []).enumerated() {
            AXUIElementSetMessagingTimeout(element, 2)
            guard let frame = reader.frame(element), frame.width > 0, frame.height > 0 else { continue }
            let title = reader.string(element, kAXTitleAttribute)
            // PID and full bounds are mandatory. A title can disambiguate equal geometry only.
            let matches = content.windows.filter { w in
                w.owningApplication?.processID == s.app.processIdentifier &&
                abs(w.frame.minX - frame.minX) <= 1 && abs(w.frame.minY - frame.minY) <= 1 &&
                abs(w.frame.width - frame.width) <= 1 && abs(w.frame.height - frame.height) <= 1
            }
            let titled = matches.filter { $0.title == title }
            let capture = matches.count == 1 ? matches.first : titled.count == 1 ? titled.first : nil
            windows.append(NativeWindow(id: "window[\(i)]", element: element, frame: frame, title: title,
                main: main.map { CFEqual($0, element) } ?? false,
                focused: focused.map { CFEqual($0, element) } ?? false,
                minimized: reader.value(element, kAXMinimizedAttribute) as? Bool ?? false, capture: capture))
        }
        sessions[id]?.windows = windows
        return windows
    }
    func selectWindow(_ params: [String: Any]) async throws -> [String: Any] {
        let windows = try await listWindows(params)
        if let selector = params["selector"] as? [String: Any] {
            let matches: [NativeWindow]
            switch selector["by"] as? String {
            case "window-id": matches = windows.filter { $0.id == selector["windowId"] as? String }
            case "main": matches = windows.filter { $0.main }
            case "focused": matches = windows.filter { $0.focused }
            case "index":
                let i = selector["index"] as? Int ?? -1
                matches = windows.indices.contains(i) ? [windows[i]] : []
            default: throw fail("NATIVE_WINDOW_NOT_FOUND", "Invalid window selector.")
            }
            guard matches.count == 1 else { throw fail(matches.isEmpty ? "NATIVE_WINDOW_NOT_FOUND" : "NATIVE_WINDOW_AMBIGUOUS", "Selector must match one window.") }
            return matches[0].json
        }
        let visible = windows.filter { $0.visible }
        for matches in [visible.filter { $0.main }, visible.filter { $0.focused }, visible] {
            if matches.count == 1 { return matches[0].json }
        }
        throw fail(visible.isEmpty ? "NATIVE_WINDOW_NOT_FOUND" : "NATIVE_WINDOW_AMBIGUOUS", "Specify a window; no unique visible main/focused window.")
    }
    func capture(_ params: [String: Any]) async throws -> [String: Any] {
        try accessibility(); try screenPermission()
        let (id, s) = try session(params)
        guard let windowID = params["windowId"] as? String,
              let old = s.windows.first(where: { $0.id == windowID }) else { throw fail("NATIVE_WINDOW_NOT_FOUND", "Select a window before capture.") }
        let fresh = try await listWindows(params)
        guard let window = fresh.first(where: { CFEqual($0.element, old.element) }), let sc = window.capture else {
            throw fail("NATIVE_WINDOW_NOT_FOUND", "Selected window is no longer capturable.")
        }
        guard let treePath = params["outputTreePath"] as? String, treePath.hasPrefix("/"),
              let pngPath = params["outputPngPath"] as? String, pngPath.hasPrefix("/"), treePath != pngPath else {
            throw fail("NATIVE_OUTPUT_WRITE_FAILED", "Distinct absolute output paths are required.")
        }
        let maxDepth = params["maxDepth"] as? Int ?? 64, maxNodes = params["maxNodes"] as? Int ?? 10000
        guard maxDepth >= 0, maxDepth <= 256, maxNodes > 0, maxNodes <= 100000 else { throw fail("NATIVE_AX_TRUNCATED", "Invalid traversal bounds.") }
        let snap = snapshot(window.element, origin: sc.frame.origin, maxDepth: maxDepth, maxNodes: maxNodes)
        let filter = SCContentFilter(desktopIndependentWindow: sc)
        let scale = Double(filter.pointPixelScale)
        let config = SCStreamConfiguration()
        config.width = Int((sc.frame.width * scale).rounded())
        config.height = Int((sc.frame.height * scale).rounded())
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        config.captureResolution = .best
        let image: CGImage
        do { image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) }
        catch { throw fail("NATIVE_SCREENSHOT_FAILED", "Window capture failed: \(error)") }
        // Re-read geometry after capture: moved/resized windows cannot produce a trusted pair.
        guard let current = AXReader().frame(window.element), current == window.frame,
              abs(Double(image.width) - sc.frame.width * scale) <= 1,
              abs(Double(image.height) - sc.frame.height * scale) <= 1 else {
            throw fail("NATIVE_COORDINATE_MISMATCH", "Window moved/resized or PNG dimensions do not match logical bounds and scale.")
        }
        _ = try session(["sessionId": id])
        let treeURL = URL(fileURLWithPath: treePath), pngURL = URL(fileURLWithPath: pngPath)
        let viewport = ["width": sc.frame.width, "height": sc.frame.height]
        // Same-directory outputs use a relative frame; other paths remain absolute and resolve unchanged downstream.
        let frame = treeURL.deletingLastPathComponent() == pngURL.deletingLastPathComponent() ? pngURL.lastPathComponent : pngPath
        let tree: [String: Any] = ["format": "vlmkit-a11y/1", "platform": "macos", "viewport": viewport,
            "scale": scale, "frame": frame, "nodes": snap.nodes]
        do {
            for url in [treeURL, pngURL] { try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true) }
            let pngTemp = pngURL.deletingLastPathComponent().appendingPathComponent(".\(UUID().uuidString).png")
            defer { try? FileManager.default.removeItem(at: pngTemp) }
            guard let dest = CGImageDestinationCreateWithURL(pngTemp as CFURL, UTType.png.identifier as CFString, 1, nil) else { throw fail("NATIVE_OUTPUT_WRITE_FAILED", "Cannot create PNG destination.") }
            CGImageDestinationAddImage(dest, image, nil)
            guard CGImageDestinationFinalize(dest) else { throw fail("NATIVE_OUTPUT_WRITE_FAILED", "Cannot encode PNG.") }
            try Data(contentsOf: pngTemp).write(to: pngURL, options: .atomic)
            try JSONSerialization.data(withJSONObject: tree, options: [.prettyPrinted, .sortedKeys]).write(to: treeURL, options: .atomic)
        } catch { throw fail("NATIVE_OUTPUT_WRITE_FAILED", "Cannot write artifacts: \(error)") }
        return ["treePath": treePath, "pngPath": pngPath, "viewport": viewport,
                "framePixels": ["width": image.width, "height": image.height], "scale": scale,
                "counts": ["nodes": snap.nodes.count, "truncated": snap.truncated, "attributeErrors": snap.attributeErrors],
                "transform": ["globalWindowOriginPoints": ["x": sc.frame.minX, "y": sc.frame.minY], "logicalToPixelScale": scale],
                "diagnostics": snap.diagnostics]
    }
    func currentWindow(_ params: [String: Any]) async throws -> (Session, NativeWindow, Double) {
        try accessibility()
        try screenPermission()
        let (_, sessionValue) = try session(params)
        guard let windowID = params["windowId"] as? String,
              let old = sessionValue.windows.first(where: { $0.id == windowID }) else {
            throw fail("NATIVE_WINDOW_NOT_FOUND", "Select a window before interaction.")
        }
        let fresh = try await listWindows(params)
        guard let window = fresh.first(where: { CFEqual($0.element, old.element) }),
              let capture = window.capture else {
            throw fail("NATIVE_WINDOW_NOT_FOUND", "Selected window is no longer available.")
        }
        let scale = Double(SCContentFilter(desktopIndependentWindow: capture).pointPixelScale)
        guard scale.isFinite, scale > 0 else {
            throw fail("NATIVE_COORDINATE_MISMATCH", "Window pixel scale is invalid.")
        }
        return (sessionValue, window, scale)
    }

    func hitTest(_ params: [String: Any]) async throws -> [String: Any] {
        let (sessionValue, window, scale) = try await currentWindow(params)
        guard let point = params["point"] as? [String: Any],
              let xPx = point["xPx"] as? Double ?? (point["xPx"] as? NSNumber)?.doubleValue,
              let yPx = point["yPx"] as? Double ?? (point["yPx"] as? NSNumber)?.doubleValue else {
            throw fail("NATIVE_COORDINATE_MISMATCH", "hitTest requires point.xPx and point.yPx.")
        }
        let pixelWidth = window.frame.width * scale
        let pixelHeight = window.frame.height * scale
        guard xPx >= 0, yPx >= 0, xPx < pixelWidth, yPx < pixelHeight else {
            throw fail("NATIVE_COORDINATE_MISMATCH", "Screenshot point is outside the selected window.")
        }
        let transform = NativeCoordinateTransform(
            globalWindowOriginPoints: window.frame.origin,
            logicalToPixelScale: scale
        )
        let global = try transform.globalPoint(xPx: xPx, yPx: yPx)
        let application = AXUIElementCreateApplication(sessionValue.app.processIdentifier)
        AXUIElementSetMessagingTimeout(application, 2)
        let element = try hitElement(application, point: global)
        guard let resolved = pathForElement(window.element, target: element, origin: window.frame.origin) else {
            throw fail("NATIVE_HIT_OUTSIDE_WINDOW", "Hit element is not a descendant of the selected window.")
        }
        let descriptor = resolved.descriptor
        let actions = descriptor["actions"] as? [String] ?? []
        let role = descriptor["role"] as? String
        let actionable = !actions.isEmpty || role == "textfield"
        let frame = AXReader().frame(element)
        let exact = frame?.contains(global) ?? false

        var ancestors: [[String: Any]] = []
        var cursor = element
        for _ in 0..<64 {
            var parentValue: CFTypeRef?
            guard AXUIElementCopyAttributeValue(cursor, kAXParentAttribute as CFString, &parentValue) == .success,
                  let parentValue,
                  CFGetTypeID(parentValue) == AXUIElementGetTypeID() else { break }
            let parent = parentValue as! AXUIElement
            if CFEqual(parent, window.element) { break }
            if let item = pathForElement(window.element, target: parent, origin: window.frame.origin) {
                ancestors.append(item.descriptor)
            }
            cursor = parent
        }

        let locator: [String: Any]
        if let identifier = descriptor["identifier"] as? String {
            locator = ["by": "stable-id", "value": identifier]
        } else if let name = descriptor["name"] as? String, let role {
            locator = ["by": "role-name", "role": role, "name": name]
        } else {
            locator = ["by": "path", "value": resolved.path]
        }

        return [
            "input": ["xPx": xPx, "yPx": yPx],
            "logical": pointJSON(transform.localPoint(global)),
            "global": pointJSON(global),
            "node": descriptor,
            "ancestors": ancestors,
            "actionable": actionable,
            "exact": exact,
            "locator": locator,
            "transform": [
                "globalWindowOriginPoints": pointJSON(window.frame.origin),
                "logicalToPixelScale": scale
            ]
        ]
    }

    func perform(_ params: [String: Any]) async throws -> [String: Any] {
        let (_, window, scale) = try await currentWindow(params)
        guard let action = params["action"] as? [String: Any],
              let kind = action["kind"] as? String else {
            throw fail("NATIVE_ACTION_UNSUPPORTED", "perform requires action.kind.")
        }
        let mode = action["mode"] as? String ?? (kind == "click" || kind == "key" || kind == "scroll" ? "physical" : "semantic")
        guard mode == "semantic" || mode == "physical" else {
            throw fail("NATIVE_ACTION_UNSUPPORTED", "Action mode must be semantic or physical.")
        }

        let locator = action["locator"] as? [String: Any]
        var resolved: NativeResolvedElement?
        var globalPoint: CGPoint?
        let transform = NativeCoordinateTransform(
            globalWindowOriginPoints: window.frame.origin,
            logicalToPixelScale: scale
        )

        if let locator, locator["by"] as? String == "point" {
            guard let xPx = locator["xPx"] as? Double ?? (locator["xPx"] as? NSNumber)?.doubleValue,
                  let yPx = locator["yPx"] as? Double ?? (locator["yPx"] as? NSNumber)?.doubleValue else {
                throw fail("NATIVE_COORDINATE_MISMATCH", "point locator requires xPx and yPx.")
            }
            let hit = try await hitTest([
                "sessionId": params["sessionId"] as Any,
                "windowId": params["windowId"] as Any,
                "point": ["xPx": xPx, "yPx": yPx]
            ])
            guard let node = hit["node"] as? [String: Any],
                  let path = node["path"] as? String else {
                throw fail("NATIVE_HIT_TEST_FAILED", "Point locator did not resolve a node path.")
            }
            resolved = try resolveLocator(window.element, origin: window.frame.origin, locator: ["by": "path", "value": path])
            globalPoint = try transform.globalPoint(xPx: xPx, yPx: yPx)
        } else if let locator {
            resolved = try resolveLocator(window.element, origin: window.frame.origin, locator: locator)
        }

        if globalPoint == nil, let element = resolved?.element, let frame = AXReader().frame(element) {
            globalPoint = CGPoint(x: frame.midX, y: frame.midY)
        }
        if globalPoint == nil {
            globalPoint = CGPoint(x: window.frame.midX, y: window.frame.midY)
        }

        switch kind {
        case "press":
            guard let element = resolved?.element else {
                throw fail("NATIVE_LOCATOR_NOT_FOUND", "press requires a locator.")
            }
            if mode == "semantic" { try semanticPress(element) }
            else { try physicalClick(at: globalPoint!) }
        case "focus":
            guard mode == "semantic", let element = resolved?.element else {
                throw fail("NATIVE_ACTION_UNSUPPORTED", "focus requires semantic mode and a locator.")
            }
            try semanticFocus(element)
        case "click":
            guard mode == "physical", resolved != nil else {
                throw fail("NATIVE_ACTION_UNSUPPORTED", "click requires physical mode and a locator.")
            }
            try physicalClick(at: globalPoint!)
        case "typeText":
            guard let text = action["text"] as? String, let element = resolved?.element else {
                throw fail("NATIVE_ACTION_UNSUPPORTED", "typeText requires text and a locator.")
            }
            if mode == "semantic" {
                try semanticSetText(element, text: text)
            } else {
                try semanticFocus(element)
                try physicalText(text)
            }
        case "key":
            guard mode == "physical", let keyCode = action["keyCode"] as? Int else {
                throw fail("NATIVE_ACTION_UNSUPPORTED", "key requires physical mode and keyCode.")
            }
            if let element = resolved?.element { try semanticFocus(element) }
            try physicalKey(keyCode, modifiers: action["modifiers"] as? [String] ?? [])
        case "scroll":
            guard mode == "physical" else {
                throw fail("NATIVE_ACTION_UNSUPPORTED", "scroll currently supports physical mode only.")
            }
            let deltaX = (action["deltaX"] as? NSNumber)?.doubleValue ?? 0
            let deltaY = (action["deltaY"] as? NSNumber)?.doubleValue ?? 0
            try physicalScroll(at: globalPoint!, deltaX: deltaX, deltaY: deltaY)
        default:
            throw fail("NATIVE_ACTION_UNSUPPORTED", "Unsupported action kind: \(kind)")
        }

        let evidence = safeActionEvidence(
            action: action,
            mode: mode,
            target: resolved?.descriptor,
            point: globalPoint
        )
        try appendActionEvidence(evidence, path: params["evidencePath"] as? String)
        return [
            "ok": true,
            "mode": mode,
            "kind": kind,
            "target": resolved?.descriptor as Any,
            "evidence": evidence
        ]
    }

    func dispatch(_ method: String, _ params: [String: Any]) async throws -> Any {
        switch method {
        case "hello":
            return ["protocol": 1, "agentVersion": "0.1.0", "bundleId": Bundle.main.bundleIdentifier ?? bundleID,
                "macOSVersion": ProcessInfo.processInfo.operatingSystemVersionString,
                "arch": ProcessInfo.processInfo.machineArchitecture,
                "capabilities": [
                    "accessibility": true,
                    "screenCapture": true,
                    "singleFrameCapture": true,
                    "hitTest": true,
                    "semanticAction": true,
                    "physicalPointer": true,
                    "physicalKeyboard": true
                ], "build": signing()] as [String: Any]
        case "doctor":
            if params["prompt"] as? Bool == true {
                requestAccessibility()
                requestScreenCapture()
            }
            let trusted = accessibilityTrusted(), authorized = screenAuthorized(), identity = signing()
            return ["accessibility": ["trusted": trusted], "screenCapture": ["authorized": authorized],
                "agent": identity.merging(["bundleId": Bundle.main.bundleIdentifier ?? bundleID]) { _, new in new },
                "checks": [["id": "accessibility", "status": trusted ? "pass" : "fail", "message": "Accessibility trust"],
                           ["id": "screenCapture", "status": authorized ? "pass" : "fail", "message": "Screen Recording authorization"],
                           ["id": "identity", "status": identity["signingKind"] as? String == "adhoc" || identity["signed"] as? Bool == false ? "warn" : "pass", "message": "Signing kind: \(identity["signingKind"] ?? "unknown")"]]] as [String: Any]
        case "target.open": try accessibility(); return try await openTarget(params["target"] as? [String: Any] ?? params)
        case "window.list": return try await listWindows(params).map(\.json)
        case "window.select": return try await selectWindow(params)
        case "snapshot.capture": return try await capture(params)
        case "hitTest": return try await hitTest(params)
        case "perform": return try await perform(params)
        case "session.close":
            let (id, s) = try session(params)
            if params["terminateIfLaunched"] as? Bool == true && s.launched { s.app.terminate() }
            sessions.removeValue(forKey: id)
            return ["closed": true]
        default: throw fail("NATIVE_PROTOCOL_MISMATCH", "Unsupported method: \(method)")
        }
    }
}
extension ProcessInfo {
    var machineArchitecture: String {
        #if arch(arm64)
        return "arm64"
        #else
        return "x86_64"
        #endif
    }
}
extension Agent {
    func respond(_ line: String) async -> String {
        var id = 0
        let response: [String: Any]
        do {
            guard let data = line.data(using: .utf8), let request = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let requestID = request["id"] as? Int else { throw fail("NATIVE_PROTOCOL_MISMATCH", "Expected NDJSON request with integer id.") }
            id = requestID
            guard request["protocol"] as? Int == 1, let method = request["method"] as? String,
                  let params = request["params"] as? [String: Any] else { throw fail("NATIVE_PROTOCOL_MISMATCH", "Expected protocol 1, method and params.") }
            response = ["id": id, "ok": true, "result": try await dispatch(method, params)]
        } catch {
            let e = error as? NativeError ?? NativeError(code: "NATIVE_AX_CANNOT_COMPLETE", message: "Native observer failed.", details: ["diagnostic": String(describing: error)])
            response = ["id": id, "ok": false, "error": ["code": e.code, "message": e.message, "details": e.details]]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else { return "{\"id\":0,\"ok\":false,\"error\":{\"code\":\"NATIVE_PROTOCOL_MISMATCH\",\"message\":\"Response serialization failed\"}}" }
        return json
    }
}
@main struct Main {
    @MainActor static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        let agent = Agent()
        // Keep AppKit/NSWorkspace/AX's run loop alive while stdin waits on a background thread.
        Task.detached {
            while let line = readLine() {
                let response = await agent.respond(line)
                print(response)
                fflush(stdout)
            }
            exit(0)
        }
        app.run()
    }
}
