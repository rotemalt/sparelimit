// A small macOS menu-bar companion for Sparelimit (D5). It runs `sparelimit status --json` every 30 seconds and shows the session cost and context in the
// menu bar, coloured by Sparelimit's own status level, with the alert text in the menu. It reads only what the CLI prints, sends nothing anywhere
// and has no dependency beyond AppKit.
//
//   scripts/menubar/build.sh                      builds ./build/SparelimitMenubar
//   build/SparelimitMenubar --node /path/to/node --sparelimit /path/to/sparelimit.mjs [--print]
//
// --print fetches once and prints what the menu would show (used by the test), then exits.
import AppKit
import Foundation

struct Reading {
    var title = "Sparelimit"
    var level = "unknown"
    var lines: [String] = []
}

func argValue(_ name: String) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
    return a[i + 1]
}

let nodePath = argValue("--node") ?? "/usr/local/bin/node"
let sparelimitPath = argValue("--sparelimit") ?? FileManager.default.currentDirectoryPath + "/sparelimit.mjs"
let dashboardURL = URL(string: "http://127.0.0.1:4321")!

/// Runs `sparelimit status --json` and turns the answer into what the menu shows. Never throws: a failure is shown as a line of text.
func fetch() -> Reading {
    var r = Reading()
    let p = Process()
    p.executableURL = URL(fileURLWithPath: nodePath)
    p.arguments = [sparelimitPath, "status", "--json"]
    p.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
    let out = Pipe()
    p.standardOutput = out
    p.standardError = Pipe()
    do { try p.run() } catch {
        r.lines = ["Could not start node at \(nodePath): \(error.localizedDescription)"]
        return r
    }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        r.lines = ["No session found (sparelimit status printed nothing readable)."]
        return r
    }
    let cost = (obj["accumulated_cost_usd"] as? Double) ?? 0
    let ctx = (obj["active_context_tokens"] as? Double) ?? 0
    r.level = (obj["statusLevel"] as? String) ?? "unknown"
    r.title = String(format: "$%.2f · %.0fk", cost, ctx / 1000)
    r.lines.append("\((obj["status"] as? String) ?? "") (\((obj["confidence"] as? String) ?? "derived"))")
    if let alert = obj["pre_action_alert"] as? String { r.lines.append(alert) }
    if let rate = (obj["spend_rate"] as? [String: Any])?["recent"] as? [String: Any], let perHour = rate["costPerHourUSD"] as? Double {
        r.lines.append(String(format: "Last 30 min: $%.2f an hour (derived)", perHour))
    }
    if let next = obj["next_turn_cost_usd"] as? Double { r.lines.append(String(format: "Next message carries about $%.3f (estimated)", next)) }
    return r
}

if CommandLine.arguments.contains("--print") {
    let r = fetch()
    print(r.title)
    print(r.level)
    r.lines.forEach { print($0) }
    exit(0)
}

final class App: NSObject, NSApplicationDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let menu = NSMenu()
    var timer: Timer?

    func applicationDidFinishLaunching(_ n: Notification) {
        item.menu = menu
        render(Reading(title: "Sparelimit …", level: "unknown", lines: ["Reading your session…"]))
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.refresh() }
    }

    @objc func refresh() {
        DispatchQueue.global(qos: .utility).async {
            let r = fetch()
            DispatchQueue.main.async { self.render(r) }
        }
    }

    @objc func openDashboard() { NSWorkspace.shared.open(dashboardURL) }

    func render(_ r: Reading) {
        let color: NSColor? = r.level == "critical" ? .systemRed : r.level == "warn" ? .systemOrange : nil
        var attrs: [NSAttributedString.Key: Any] = [:]
        if let c = color { attrs[.foregroundColor] = c }
        item.button?.attributedTitle = NSAttributedString(string: "⚡ " + r.title, attributes: attrs)
        menu.removeAllItems()
        for l in r.lines {
            let m = NSMenuItem(title: String(l.prefix(110)), action: nil, keyEquivalent: "")
            m.isEnabled = false
            menu.addItem(m)
        }
        menu.addItem(.separator())
        let open = NSMenuItem(title: "Open dashboard (sparelimit serve)", action: #selector(openDashboard), keyEquivalent: "d")
        open.target = self
        menu.addItem(open)
        let ref = NSMenuItem(title: "Refresh now", action: #selector(refresh), keyEquivalent: "r")
        ref.target = self
        menu.addItem(ref)
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // no Dock icon
let delegate = App()
app.delegate = delegate
app.run()
