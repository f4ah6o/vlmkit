import AppKit
import ApplicationServices

struct NativeError: Error {
    let code: String
    let message: String
    var details: [String: Any] = [:]
}
func fail(_ code: String, _ message: String) -> NativeError { NativeError(code: code, message: message) }
func rectJSON(_ r: CGRect) -> [String: Double] {
    ["left": r.minX, "top": r.minY, "width": r.width, "height": r.height]
}
let roles = ["AXButton": "button", "AXLink": "link", "AXTextField": "textfield",
             "AXTextArea": "textfield", "AXCheckBox": "checkbox", "AXRadioButton": "radio",
             "AXSlider": "slider", "AXTab": "tab", "AXMenuItem": "menuitem",
             "AXPopUpButton": "combobox", "AXComboBox": "combobox", "AXStaticText": "text",
             "AXImage": "image", "AXGroup": "group", "AXList": "list",
             "AXScrollArea": "scrollview", "AXWindow": "window"]
func normalizedRole(_ role: String, _ subrole: String?, _ parent: String?) -> String {
    if role == "AXWindow", ["AXDialog", "AXSystemDialog"].contains(subrole ?? "") { return "dialog" }
    if role == "AXRow", ["list", "AXTable", "AXOutline"].contains(parent ?? "") { return "listitem" }
    return roles[role] ?? role
}
final class AXReader {
    var errors = 0
    var diagnostics: [[String: Any]] = []
    func value(_ el: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var result: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(el, attribute as CFString, &result)
        if status == .success { return result }
        if status != .attributeUnsupported && status != .noValue {
            errors += 1
            diagnostics.append(["code": status == .cannotComplete ? "NATIVE_AX_CANNOT_COMPLETE" : "NATIVE_AX_ATTRIBUTE_ERROR",
                                "attribute": attribute, "status": status.rawValue])
        }
        return nil
    }
    func string(_ el: AXUIElement, _ attr: String) -> String? {
        guard let v = value(el, attr) as? String, !v.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return v
    }
    func frame(_ el: AXUIElement) -> CGRect? {
        guard let p = value(el, kAXPositionAttribute), let s = value(el, kAXSizeAttribute),
              CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size),
              [point.x, point.y, size.width, size.height].allSatisfy({ $0.isFinite }), size.width >= 0, size.height >= 0 else { return nil }
        return CGRect(origin: point, size: size)
    }
    func children(_ el: AXUIElement) -> [AXUIElement] { value(el, kAXChildrenAttribute) as? [AXUIElement] ?? [] }
}
func scalar(_ value: CFTypeRef?) -> String? {
    if let n = value as? NSNumber {
        if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue ? "true" : "false" }
        return n.stringValue
    }
    return value as? String
}
func checkedState(_ role: String, _ value: CFTypeRef?) -> Bool? {
    guard role == "AXCheckBox", let number = value as? NSNumber else { return nil }
    if number == 0 { return false }
    if number == 1 { return true }
    return nil // mixed or an unknown representation stays in value
}
struct AXSnapshot {
    var nodes: [[String: Any]]
    var truncated: Int
    var attributeErrors: Int
    var diagnostics: [[String: Any]]
}
func snapshot(_ root: AXUIElement, origin: CGPoint, maxDepth: Int, maxNodes: Int) -> AXSnapshot {
    let reader = AXReader()
    var nodes: [[String: Any]] = []
    var visited: [CFHashCode: [AXUIElement]] = [:]
    var identifiers = Set<String>(), truncated = 0
    func walk(_ el: AXUIElement, parentPath: String?, parentRole: String?, ordinal: Int, depth: Int) {
        let hash = CFHash(el)
        if visited[hash, default: []].contains(where: { CFEqual($0, el) }) { return }
        if depth > maxDepth || nodes.count >= maxNodes { truncated += 1; return }
        visited[hash, default: []].append(el)
        AXUIElementSetMessagingTimeout(el, 2)
        let platformRole = reader.string(el, kAXRoleAttribute) ?? "AXUnknown"
        let subrole = reader.string(el, kAXSubroleAttribute)
        let role = normalizedRole(platformRole, subrole, parentRole)
        let segment = "\(role)[\(ordinal)]"
        let path = parentPath.map { "\($0)>\(segment)" } ?? segment
        var actionNames: CFArray?
        let actionStatus = AXUIElementCopyActionNames(el, &actionNames)
        if actionStatus != .success && actionStatus != .actionUnsupported {
            reader.errors += 1
            reader.diagnostics.append(["code": "NATIVE_AX_CANNOT_COMPLETE", "path": path, "status": actionStatus.rawValue])
        }
        var actions = (actionNames as? [String] ?? []).map { action -> String in
            switch action {
            case kAXPressAction: return "tap"
            case kAXIncrementAction: return "increment"
            case kAXDecrementAction: return "decrement"
            default: return "ax:\(action)"
            }
        }
        var settable = DarwinBoolean(false)
        if role == "textfield", AXUIElementIsAttributeSettable(el, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue { actions.append("setText") }
        if role == "scrollview" { actions.append("scroll") }
        let frame = reader.frame(el)
        if frame == nil {
            reader.diagnostics.append(["code": "NATIVE_AX_INVALID_GEOMETRY", "path": path])
        }
        if platformRole == "AXUnknown" { reader.diagnostics.append(["code": "NATIVE_AX_MISSING_ROLE", "path": path]) }
        let local = (frame ?? CGRect(origin: origin, size: .zero)).offsetBy(dx: -origin.x, dy: -origin.y)
        var node: [String: Any] = ["path": path, "role": role, "platformRole": platformRole, "rect": rectJSON(local)]
        if let subrole { node["platformSubrole"] = subrole }
        if let id = reader.string(el, kAXIdentifierAttribute) {
            node["identifier"] = id
            if !identifiers.insert(id).inserted { reader.diagnostics.append(["code": "NATIVE_DUPLICATE_IDENTIFIER", "identifier": id, "path": path]) }
        }
        var titleText: String?
        if let titleElement = reader.value(el, kAXTitleUIElementAttribute), CFGetTypeID(titleElement) == AXUIElementGetTypeID() {
            let title = titleElement as! AXUIElement
            titleText = reader.string(title, kAXTitleAttribute) ?? reader.string(title, kAXValueAttribute)
        }
        // Static text's scalar value is its announced content; editable values are never names.
        if let name = reader.string(el, kAXTitleAttribute) ?? titleText ?? reader.string(el, kAXDescriptionAttribute)
            ?? (platformRole == "AXStaticText" ? reader.string(el, kAXValueAttribute) : nil) { node["name"] = name }
        if let value = scalar(reader.value(el, kAXValueAttribute)) { node["value"] = value }
        var states: [String: Bool] = [:]
        if let enabled = reader.value(el, kAXEnabledAttribute) as? Bool, !enabled { states["disabled"] = true }
        for (attr, key) in [(kAXFocusedAttribute, "focused"), (kAXSelectedAttribute, "selected"), (kAXExpandedAttribute, "expanded")] {
            if let v = reader.value(el, attr) as? Bool, v { states[key] = true }
        }
        if let checked = checkedState(platformRole, reader.value(el, kAXValueAttribute)) { states["checked"] = checked }
        if !states.isEmpty { node["states"] = states }
        if !actions.isEmpty { node["actions"] = actions }
        nodes.append(node)
        for (i, child) in reader.children(el).enumerated() { walk(child, parentPath: path, parentRole: role, ordinal: i, depth: depth + 1) }
    }
    walk(root, parentPath: nil, parentRole: nil, ordinal: 0, depth: 0)
    return AXSnapshot(nodes: nodes, truncated: truncated, attributeErrors: reader.errors, diagnostics: reader.diagnostics)
}
