// Hitch.app: a native window around the Hitch UI, so Hitch has its own Dock
// icon, Cmd-Tab entry and Cmd-Q. It starts Hitch (Contents/Resources/start-hitch)
// unless one is already serving, shows its page, and stops the Hitch it started
// when the app quits, which saves the report.

import Cocoa
import WebKit

let hitchURL = URL(string: "http://127.0.0.1:7370/")!

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var server: Process?
    var readyTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: .zero, configuration: config)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.loadHTMLString(Self.startingPage, baseURL: nil)

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Hitch"
        window.minSize = NSSize(width: 900, height: 560)
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("HitchMain")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        isServing { serving in
            if !serving { self.startServer() }
            self.waitUntilServing()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // Hitch saves its report on SIGTERM; give it a moment before the app exits.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let server, server.isRunning else { return .terminateNow }
        server.terminationHandler = { _ in DispatchQueue.main.async { NSApp.reply(toApplicationShouldTerminate: true) } }
        server.terminate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { NSApp.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }

    func isServing(_ done: @escaping (Bool) -> Void) {
        var request = URLRequest(url: hitchURL.appendingPathComponent("manifest.webmanifest"))
        request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { data, _, _ in
            let ok = data.flatMap { String(data: $0, encoding: .utf8) }?.contains("\"Hitch\"") ?? false
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }

    func startServer() {
        guard let script = Bundle.main.url(forResource: "start-hitch", withExtension: nil) else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [script.path]
        do { try process.run() } catch { showError("Couldn't start Hitch: \(error.localizedDescription)") ; return }
        server = process
    }

    func waitUntilServing(attempt: Int = 0) {
        isServing { serving in
            if serving {
                self.webView.load(URLRequest(url: hitchURL))
            } else if attempt < 100 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.waitUntilServing(attempt: attempt + 1) }
            } else {
                self.showError("Hitch didn't start. See ~/.hitch/app.log.")
            }
        }
    }

    func showError(_ text: String) {
        webView.loadHTMLString(Self.startingPage.replacingOccurrences(of: "Starting Hitch…", with: text), baseURL: nil)
    }

    // The page reloading after Hitch restarts, or a dropped connection: try again.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.waitUntilServing() }
    }

    // Links meant for a new tab open in the browser instead.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, url.host != nil, url.host != hitchURL.host, navigationAction.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    @objc func reload() { webView.reload() }

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Hitch", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Hitch", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Hitch", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f").keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = view
        main.addItem(viewItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu
        NSApp.mainMenu = main
    }

    static let startingPage = """
    <html><body style="margin:0;height:100vh;display:grid;place-items:center;background:#18181b;color:#a1a1aa;font:15px -apple-system,sans-serif">Starting Hitch…</body></html>
    """
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
