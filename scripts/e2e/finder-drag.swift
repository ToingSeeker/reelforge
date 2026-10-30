// Starts a real AppKit file drag from a tiny window and drops it on the window of another app.
// usage: drag <file> <owner-name-substring>
import AppKit

let file = URL(fileURLWithPath: CommandLine.arguments[1])
let owner = CommandLine.arguments[2]

/// Centre of the target app's main window (CG coordinates, origin top-left), after bringing it to the front
/// so nothing else covers the drop point.
func targetCenter() -> CGPoint? {
  let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
  for w in list {
    guard let name = w[kCGWindowOwnerName as String] as? String, name.localizedCaseInsensitiveContains(owner),
          (w[kCGWindowLayer as String] as? Int) == 0,
          let b = w[kCGWindowBounds as String] as? [String: CGFloat], (b["Width"] ?? 0) > 400 else { continue }
    if let pid = w[kCGWindowOwnerPID as String] as? pid_t { NSRunningApplication(processIdentifier: pid)?.activate() }
    return CGPoint(x: b["X"]! + b["Width"]! / 2, y: b["Y"]! + b["Height"]! / 2)
  }
  return nil
}

final class Source: NSView, NSDraggingSource {
  func draggingSession(_ s: NSDraggingSession, sourceOperationMaskFor c: NSDraggingContext) -> NSDragOperation { .copy }
  func draggingSession(_ s: NSDraggingSession, endedAt p: NSPoint, operation: NSDragOperation) {
    print("drag ended, operation=\(operation.rawValue)")
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { exit(operation.isEmpty ? 4 : 0) } // 4: the target refused the drop
  }
  // The target app is in front, so our first click must start the drag rather than just activate us.
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func mouseDown(with e: NSEvent) {
    let item = NSDraggingItem(pasteboardWriter: file as NSURL)
    item.setDraggingFrame(NSRect(x: 0, y: 0, width: 32, height: 32), contents: NSImage(size: NSSize(width: 32, height: 32)))
    beginDraggingSession(with: [item], event: e, source: self)
    print("drag started")
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let screen = NSScreen.screens[0].frame
let win = NSWindow(contentRect: NSRect(x: 40, y: screen.height - 200, width: 120, height: 120), styleMask: [.titled], backing: .buffered, defer: false)
win.contentView = Source(frame: NSRect(x: 0, y: 0, width: 120, height: 120))
win.level = .floating
win.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)

DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
  guard let to = targetCenter() else { print("target window not found"); exit(2) }
  usleep(800_000) // let the activation land; the source window stays on top (.floating)
  // CG coordinates: origin top-left. Window content centre:
  let from = CGPoint(x: 40 + 60, y: 200 - 60 + 28 / 2)
  let src = CGEventSource(stateID: .hidSystemState)
  func post(_ t: CGEventType, _ p: CGPoint) { CGEvent(mouseEventSource: src, mouseType: t, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap) }
  post(.mouseMoved, from); usleep(100_000)
  post(.leftMouseDown, from); usleep(150_000)
  DispatchQueue.global().async {
    let steps = 40
    for i in 1...steps {
      let t = CGFloat(i) / CGFloat(steps)
      post(.leftMouseDragged, CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)); usleep(25_000)
    }
    usleep(400_000)
    post(.leftMouseUp, to)
    print("dropped at \(to)")
  }
}
DispatchQueue.main.asyncAfter(deadline: .now() + 10) { print("timeout"); exit(3) }
app.run()
