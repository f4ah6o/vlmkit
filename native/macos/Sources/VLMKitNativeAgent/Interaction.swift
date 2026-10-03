import AppKit
import ApplicationServices
import CoreGraphics

struct NativeCoordinateTransform {
    let globalWindowOriginPoints: CGPoint
    let logicalToPixelScale: Double

    func globalPoint(xPx: Double, yPx: Double) throws -> CGPoint {
        guard logicalToPixelScale.isFinite, logicalToPixelScale > 0,
              xPx.isFinite, yPx.isFinite, xPx >= 0, yPx >= 0 else {
            throw fail("NATIVE_COORDINATE_MISMATCH", "Pixel coordinates and scale must be finite and non-negative.")
        }
        return CGPoint(
            x: globalWindowOriginPoints.x + xPx / logicalToPixelScale,
            y: globalWindowOriginPoints.y + yPx / logicalToPixelScale
        )
    }

    func localPoint(_ global: CGPoint) -> CGPoint {
        CGPoint(
            x: global.x - globalWindowOriginPoints.x,
            y: global.y - globalWindowOriginPoints.y
        )
    }
}

func pointJSON(_ point: CGPoint) -> [String: Double] {
    ["x": point.x, "y": point.y]
}

func normalizedActions(_ element: AXUIElement, reader: AXReader) -> [String] {
    var actionNames: CFArray?
    let status = AXUIElementCopyActionNames(element, &actionNames)
    if status != .success && status != .actionUnsupported {
        reader.errors += 1
        reader.diagnostics.append(["code": "NATIVE_AX_CANNOT_COMPLETE", "status": status.rawValue])
    }
    var actions = (actionNames as? [String] ?? []).map { action -> String in
        switch action {
        case kAXPressAction: return "tap"
        case kAXIncrementAction: return "increment"
        case kAXDecrementAction: return "decrement"
        default: return "ax:\(action)"
        }
    }
    let role = reader.string(element, kAXRoleAttribute) ?? "AXUnknown"
    var settable = DarwinBoolean(false)
    if ["AXTextField", "AXTextArea"].contains(role),
       AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success,
       settable.boolValue {
        actions.append("setText")
    }
    if role == "AXScrollArea" { actions.append("scroll") }
    return actions
}

func describeElement(_ element: AXUIElement, origin: CGPoint, path: String? = nil) -> [String: Any] {
    let reader = AXReader()
    let platformRole = reader.string(element, kAXRoleAttribute) ?? "AXUnknown"
    let subrole = reader.string(element, kAXSubroleAttribute)
    let role = normalizedRole(platformRole, subrole, nil)
    let frame = reader.frame(element)
    let local = frame?.offsetBy(dx: -origin.x, dy: -origin.y) ?? .zero
    var out: [String: Any] = [
        "role": role,
        "platformRole": platformRole,
        "rect": rectJSON(local),
        "actions": normalizedActions(element, reader)
    ]
    if let path { out["path"] = path }
    if let subrole { out["platformSubrole"] = subrole }
    if let identifier = reader.string(element, kAXIdentifierAttribute) { out["identifier"] = identifier }
    if let name = reader.string(element, kAXTitleAttribute)
        ?? reader.string(element, kAXDescriptionAttribute)
        ?? (platformRole == "AXStaticText" ? reader.string(element, kAXValueAttribute) : nil) {
        out["name"] = name
    }
    if let value = scalar(reader.value(element, kAXValueAttribute)), !["AXTextField", "AXTextArea"].contains(platformRole) {
        out["value"] = value
    }
    var states: [String: Bool] = [:]
    if let enabled = reader.value(element, kAXEnabledAttribute) as? Bool, !enabled { states["disabled"] = true }
    for (attribute, key) in [
        (kAXFocusedAttribute, "focused"),
        (kAXSelectedAttribute, "selected"),
        (kAXExpandedAttribute, "expanded")
    ] {
        if let value = reader.value(element, attribute) as? Bool, value { states[key] = true }
    }
    if let checked = checkedState(platformRole, reader.value(element, kAXValueAttribute)) { states["checked"] = checked }
    if !states.isEmpty { out["states"] = states }
    return out
}

struct NativeResolvedElement {
    let element: AXUIElement
    let path: String
    let descriptor: [String: Any]
}

func chooseLocatorCandidate<T>(_ candidates: [T], nth: Int? = nil) throws -> T {
    if let nth {
        guard nth >= 0, candidates.indices.contains(nth) else {
            throw NativeError(
                code: "NATIVE_LOCATOR_NOT_FOUND",
                message: "Locator nth does not identify an existing candidate.",
                details: ["candidateCount": candidates.count, "nth": nth]
            )
        }
        return candidates[nth]
    }
    guard candidates.count == 1 else {
        throw NativeError(
            code: candidates.isEmpty ? "NATIVE_LOCATOR_NOT_FOUND" : "NATIVE_LOCATOR_AMBIGUOUS",
            message: candidates.isEmpty ? "Locator did not match any element." : "Locator matched multiple elements.",
            details: ["candidateCount": candidates.count]
        )
    }
    return candidates[0]
}

func collectElements(_ root: AXUIElement, origin: CGPoint, maxNodes: Int = 10000) -> [NativeResolvedElement] {
    let reader = AXReader()
    var result: [NativeResolvedElement] = []
    var visited: [CFHashCode: [AXUIElement]] = [:]

    func walk(_ element: AXUIElement, parentPath: String?, parentRole: String?, ordinal: Int) {
        guard result.count < maxNodes else { return }
        let hash = CFHash(element)
        if visited[hash, default: []].contains(where: { CFEqual($0, element) }) { return }
        visited[hash, default: []].append(element)
        AXUIElementSetMessagingTimeout(element, 2)

        let platformRole = reader.string(element, kAXRoleAttribute) ?? "AXUnknown"
        let role = normalizedRole(platformRole, reader.string(element, kAXSubroleAttribute), parentRole)
        let segment = "\(role)[\(ordinal)]"
        let path = parentPath.map { "\($0)>\(segment)" } ?? segment
        result.append(NativeResolvedElement(
            element: element,
            path: path,
            descriptor: describeElement(element, origin: origin, path: path)
        ))
        for (index, child) in reader.children(element).enumerated() {
            walk(child, parentPath: path, parentRole: role, ordinal: index)
        }
    }

    walk(root, parentPath: nil, parentRole: nil, ordinal: 0)
    return result
}

func pathForElement(_ root: AXUIElement, target: AXUIElement, origin: CGPoint) -> NativeResolvedElement? {
    collectElements(root, origin: origin).first { CFEqual($0.element, target) }
}

func resolveLocator(_ root: AXUIElement, origin: CGPoint, locator: [String: Any]) throws -> NativeResolvedElement {
    let all = collectElements(root, origin: origin)
    let by = locator["by"] as? String
    switch by {
    case "stable-id":
        guard let value = locator["value"] as? String, !value.isEmpty else {
            throw fail("NATIVE_LOCATOR_NOT_FOUND", "stable-id locator requires a non-empty value.")
        }
        return try chooseLocatorCandidate(all.filter { ($0.descriptor["identifier"] as? String) == value })
    case "path":
        guard let value = locator["value"] as? String, !value.isEmpty else {
            throw fail("NATIVE_LOCATOR_NOT_FOUND", "path locator requires a non-empty value.")
        }
        return try chooseLocatorCandidate(all.filter { $0.path == value })
    case "role-name":
        guard let role = locator["role"] as? String, let name = locator["name"] as? String else {
            throw fail("NATIVE_LOCATOR_NOT_FOUND", "role-name locator requires role and name.")
        }
        let candidates = all.filter {
            ($0.descriptor["role"] as? String) == role && ($0.descriptor["name"] as? String) == name
        }
        return try chooseLocatorCandidate(candidates, nth: locator["nth"] as? Int)
    default:
        throw fail("NATIVE_LOCATOR_NOT_FOUND", "Expected stable-id, role-name, or path locator.")
    }
}

func hitElement(_ application: AXUIElement, point: CGPoint) throws -> AXUIElement {
    var element: AXUIElement?
    let status = AXUIElementCopyElementAtPosition(application, Float(point.x), Float(point.y), &element)
    guard status == .success, let element else {
        throw NativeError(
            code: "NATIVE_HIT_TEST_FAILED",
            message: "Accessibility hit test failed.",
            details: ["status": status.rawValue]
        )
    }
    AXUIElementSetMessagingTimeout(element, 2)
    return element
}

func semanticPress(_ element: AXUIElement) throws {
    let status = AXUIElementPerformAction(element, kAXPressAction as CFString)
    guard status == .success else {
        throw NativeError(
            code: "NATIVE_ACTION_UNSUPPORTED",
            message: "Element does not support semantic press.",
            details: ["status": status.rawValue]
        )
    }
}

func semanticFocus(_ element: AXUIElement) throws {
    let status = AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    guard status == .success else {
        throw NativeError(
            code: "NATIVE_ACTION_UNSUPPORTED",
            message: "Element cannot be focused.",
            details: ["status": status.rawValue]
        )
    }
}

func semanticSetText(_ element: AXUIElement, text: String) throws {
    let status = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFString)
    guard status == .success else {
        throw NativeError(
            code: "NATIVE_ACTION_UNSUPPORTED",
            message: "Element does not support setting text.",
            details: ["status": status.rawValue]
        )
    }
}

func eventSource() throws -> CGEventSource {
    guard let source = CGEventSource(stateID: .hidSystemState) else {
        throw fail("NATIVE_INPUT_FAILED", "Cannot create CoreGraphics input source.")
    }
    return source
}

func physicalClick(at point: CGPoint) throws {
    let source = try eventSource()
    guard let down = CGEvent(
        mouseEventSource: source,
        mouseType: .leftMouseDown,
        mouseCursorPosition: point,
        mouseButton: .left
    ), let up = CGEvent(
        mouseEventSource: source,
        mouseType: .leftMouseUp,
        mouseCursorPosition: point,
        mouseButton: .left
    ) else {
        throw fail("NATIVE_INPUT_FAILED", "Cannot create mouse events.")
    }
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

func eventFlags(_ names: [String]) throws -> CGEventFlags {
    var flags: CGEventFlags = []
    for name in names {
        switch name {
        case "command": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "option": flags.insert(.maskAlternate)
        case "control": flags.insert(.maskControl)
        case "fn": flags.insert(.maskSecondaryFn)
        default: throw fail("NATIVE_INPUT_FAILED", "Unknown keyboard modifier: \(name)")
        }
    }
    return flags
}

func physicalKey(_ keyCode: Int, modifiers: [String]) throws {
    guard keyCode >= 0, keyCode <= Int(UInt16.max) else {
        throw fail("NATIVE_INPUT_FAILED", "keyCode is outside the CoreGraphics virtual-key range.")
    }
    let source = try eventSource()
    guard let down = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(keyCode), keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(keyCode), keyDown: false) else {
        throw fail("NATIVE_INPUT_FAILED", "Cannot create keyboard events.")
    }
    let flags = try eventFlags(modifiers)
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

func physicalText(_ text: String) throws {
    let source = try eventSource()
    guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
        throw fail("NATIVE_INPUT_FAILED", "Cannot create text input events.")
    }
    let units = Array(text.utf16)
    units.withUnsafeBufferPointer { buffer in
        if let base = buffer.baseAddress {
            down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
            up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: base)
        }
    }
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

func physicalScroll(at point: CGPoint, deltaX: Double, deltaY: Double) throws {
    let source = try eventSource()
    guard deltaX.isFinite, deltaY.isFinite,
          let event = CGEvent(
            scrollWheelEvent2Source: source,
            units: .pixel,
            wheelCount: 2,
            wheel1: Int32(clamping: Int(-deltaY.rounded())),
            wheel2: Int32(clamping: Int(-deltaX.rounded())),
            wheel3: 0
          ) else {
        throw fail("NATIVE_INPUT_FAILED", "Cannot create scroll event.")
    }
    event.location = point
    event.post(tap: .cghidEventTap)
}

func appendActionEvidence(_ record: [String: Any], path: String?) throws {
    guard let path else { return }
    guard path.hasPrefix("/") else {
        throw fail("NATIVE_OUTPUT_WRITE_FAILED", "Action evidence path must be absolute.")
    }
    let url = URL(fileURLWithPath: path)
    do {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
        if !FileManager.default.fileExists(atPath: path) {
            FileManager.default.createFile(atPath: path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: data)
        try handle.write(contentsOf: Data([0x0A]))
    } catch {
        throw fail("NATIVE_OUTPUT_WRITE_FAILED", "Cannot append action evidence: \(error)")
    }
}

func safeActionEvidence(
    action: [String: Any],
    mode: String,
    target: [String: Any]?,
    point: CGPoint?
) -> [String: Any] {
    var safeAction = action
    if let text = safeAction.removeValue(forKey: "text") as? String {
        safeAction["textLength"] = text.utf16.count
    }
    var record: [String: Any] = [
        "timestamp": ISO8601DateFormatter().string(from: Date()),
        "mode": mode,
        "action": safeAction
    ]
    if let target { record["target"] = target }
    if let point { record["globalPoint"] = pointJSON(point) }
    return record
}
