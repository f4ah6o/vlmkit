import AppKit

final class FixtureDelegate: NSObject, NSApplicationDelegate {
    var windows: [NSWindow] = []
    func button(_ title: String, _ id: String?, _ frame: NSRect, in view: NSView) -> NSButton {
        let button = NSButton(frame: frame)
        button.title = title
        button.bezelStyle = .rounded
        if let id { button.setAccessibilityIdentifier(id) }
        view.addSubview(button)
        return button
    }
    func makeWindow(_ title: String, ordinary: Bool = false) -> NSWindow {
        // Borderless ordinary windows deliberately have no main/focused AX window in ambiguity mode.
        let window = NSWindow(contentRect: NSRect(x: 160, y: 180, width: 640, height: 480),
                              styleMask: ordinary ? [.borderless] : [.titled, .closable], backing: .buffered, defer: false)
        window.title = title
        window.setAccessibilityIdentifier("fixture.window")
        window.isReleasedWhenClosed = false
        window.contentView?.wantsLayer = true
        window.contentView?.layer?.backgroundColor = NSColor.white.cgColor
        windows.append(window)
        return window
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let window = makeWindow("VLMKit AX Fixture")
        let view = window.contentView!
        _ = button("Save", "fixture.save", NSRect(x: 30, y: 390, width: 100, height: 36), in: view)
        let unnamed = button("", "fixture.unnamed", NSRect(x: 140, y: 390, width: 16, height: 16), in: view)
        unnamed.setAccessibilityLabel("")
        _ = button("Nearby", "fixture.nearby", NSRect(x: 155, y: 390, width: 80, height: 36), in: view)
        let field = NSTextField(frame: NSRect(x: 30, y: 330, width: 220, height: 32))
        field.stringValue = "Ada"
        field.setAccessibilityIdentifier("fixture.name")
        field.setAccessibilityLabel("Name")
        view.addSubview(field)
        let checkbox = NSButton(checkboxWithTitle: "Remember", target: nil, action: nil)
        checkbox.frame = NSRect(x: 30, y: 280, width: 130, height: 30)
        checkbox.state = CommandLine.arguments.contains("--unchecked") ? .off : .on
        checkbox.setAccessibilityIdentifier("fixture.remember")
        view.addSubview(checkbox)
        let disabled = button("Disabled", "fixture.disabled", NSRect(x: 280, y: 330, width: 110, height: 36), in: view)
        disabled.isEnabled = false
        _ = button("Duplicate", "fixture.duplicate.one", NSRect(x: 280, y: 280, width: 110, height: 36), in: view)
        _ = button("Duplicate", CommandLine.arguments.contains("--duplicate-identifiers") ? "fixture.duplicate.one" : "fixture.duplicate.two", NSRect(x: 400, y: 280, width: 110, height: 36), in: view)
        let dialog = button("Open dialog", "fixture.dialog", NSRect(x: 280, y: 390, width: 140, height: 36), in: view)
        dialog.target = self; dialog.action = #selector(openDialog)
        let scroll = NSScrollView(frame: NSRect(x: 30, y: 30, width: 560, height: 200))
        scroll.hasVerticalScroller = true
        scroll.setAccessibilityIdentifier("fixture.scroll")
        let document = NSView(frame: NSRect(x: 0, y: 0, width: 540, height: 600))
        _ = button("Offscreen scroll control", "fixture.offscreen", NSRect(x: 20, y: 540, width: 220, height: 36), in: document)
        _ = button("Visible scroll control", "fixture.scroll.visible", NSRect(x: 20, y: 20, width: 220, height: 36), in: document)
        scroll.documentView = document
        view.addSubview(scroll)
        if CommandLine.arguments.contains("--two-windows") {
            let second = makeWindow("VLMKit AX Fixture Second")
            second.setFrameOrigin(NSPoint(x: 850, y: 180))
            second.orderFront(nil)
        }
        if CommandLine.arguments.contains("--ambiguous") {
            window.orderOut(nil)
            for i in 0..<2 {
                let extra = makeWindow("Ordinary \(i)", ordinary: true)
                extra.setFrameOrigin(NSPoint(x: 160 + i * 660, y: 180))
                extra.orderFront(nil)
            }
        } else { window.makeKeyAndOrderFront(nil) }
        NSApp.activate(ignoringOtherApps: true)
    }
    @objc func openDialog() {
        let panel = NSPanel(contentRect: NSRect(x: 320, y: 320, width: 300, height: 160),
                            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        panel.title = "Fixture dialog"
        panel.setAccessibilitySubrole(.dialog)
        panel.isReleasedWhenClosed = false
        windows.append(panel)
        _ = button("Close", "fixture.dialog.close", NSRect(x: 90, y: 50, width: 120, height: 36), in: panel.contentView!)
        panel.makeKeyAndOrderFront(nil)
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = FixtureDelegate()
app.delegate = delegate
app.run()
