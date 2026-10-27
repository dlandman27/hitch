// Hitch.app: a native window around the Hitch UI, so Hitch has its own Dock
// icon, Cmd-Tab entry and Cmd-Q. It starts Hitch (Contents/Resources/start-hitch)
// unless one is already serving, shows its page, and stops the Hitch it started
// when the app quits, which saves the report.

import Cocoa
import WebKit

let hitchURL = URL(string: "http://127.0.0.1:7370/")!

// The page draws a 52pt toolbar at the top (like Xcode's unified toolbar);
// the window's own title bar is hidden behind it and the traffic lights are
// centered in that bar.
let toolbarHeight: CGFloat = 52

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!
    var server: Process?
    var readyTimer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        // Tells the page it is inside Hitch.app, so it leaves room for the traffic
        // lights and lets its toolbar drag the window.
        let shell = """
        document.documentElement.dataset.shell = 'mac';
        addEventListener('mousedown', e => {
          if (e.button !== 0 || !e.target.closest('.topbar')) return;
          if (e.target.closest('button, a, input, select, textarea, [role=group], sl-dropdown, sl-radio-group, sl-tooltip *, sl-menu, .vital')) return;
          window.webkit.messageHandlers.hitch.postMessage(e.detail === 2 ? 'zoom' : 'drag');
        }, true);
        """
        config.userContentController.addUserScript(WKUserScript(source: shell, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.add(self, name: "hitch")
        webView = WKWebView(frame: .zero, configuration: config)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.loadHTMLString(Self.statusPage("Starting Hitch…", spinning: true), baseURL: nil)

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900), styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "Hitch"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(calibratedRed: 0.17, green: 0.17, blue: 0.18, alpha: 1)
        window.appearance = NSAppearance(named: .darkAqua)
        window.delegate = self
        window.minSize = NSSize(width: 900, height: 560)
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("HitchMain")
        window.makeKeyAndOrderFront(nil)
        layoutTrafficLights()
        NSApp.activate(ignoringOtherApps: true)

        isServing { serving in
            if !serving { self.startServer() }
            self.waitUntilServing()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // Centers the close/minimize/zoom buttons in the page's 52pt toolbar.
    func layoutTrafficLights() {
        guard let close = window.standardWindowButton(.closeButton), let titlebar = close.superview?.superview else { return }
        if window.styleMask.contains(.fullScreen) { return }
        var frame = titlebar.frame
        frame.size.height = toolbarHeight
        frame.origin.y = window.frame.height - toolbarHeight
        titlebar.frame = frame
        let buttons: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]
        for (index, type) in buttons.enumerated() {
            guard let button = window.standardWindowButton(type) else { continue }
            button.setFrameOrigin(NSPoint(x: 18 + CGFloat(index) * 20, y: (toolbarHeight - button.frame.height) / 2))
        }
    }

    func windowDidResize(_ notification: Notification) { layoutTrafficLights() }
    func windowDidBecomeKey(_ notification: Notification) { layoutTrafficLights() }
    func windowDidExitFullScreen(_ notification: Notification) {
        layoutTrafficLights()
        webView.evaluateJavaScript("document.documentElement.dataset.shell = 'mac'")
    }
    func windowWillEnterFullScreen(_ notification: Notification) {
        // No traffic lights in full screen: the toolbar can use the space.
        webView.evaluateJavaScript("document.documentElement.dataset.shell = 'mac-fullscreen'")
    }

    // The page's toolbar is the title bar: dragging it moves the window, and a
    // double-click zooms (or minimizes, per the system setting).
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let action = message.body as? String else { return }
        if action == "drag", let event = NSApp.currentEvent {
            window.performDrag(with: event)
        } else if action == "zoom" {
            if UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") == "Minimize" {
                window.performMiniaturize(nil)
            } else {
                window.performZoom(nil)
            }
        }
    }

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
        webView.loadHTMLString(Self.statusPage(text, spinning: false), baseURL: nil)
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

    // Shown before Hitch's server answers: the logo, a line of status, and a
    // spinner while starting. The logo ships inside the app bundle.
    static func statusPage(_ text: String, spinning: Bool) -> String {
        let logo = Bundle.main.url(forResource: "hitch-mark", withExtension: "svg").flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? ""
        let escaped = text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        return """
        <html><head><meta charset="utf-8"><style>
          html, body { margin: 0; height: 100vh; background: #1e1e1e; color: rgba(235,235,245,.6); font: 13px -apple-system, sans-serif; -webkit-user-select: none; }
          body { display: grid; place-content: center; justify-items: center; gap: 14px; }
          .logo svg { width: 72px; height: 72px; }
          .title { color: #fff; font-size: 20px; font-weight: 700; letter-spacing: -0.01em; }
          .spinner { width: 16px; height: 16px; border: 2px solid rgba(235,235,245,.18); border-top-color: #2463eb; border-radius: 50%; animation: spin .8s linear infinite; }
          @keyframes spin { to { transform: rotate(360deg); } }
          @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 3s; } }
        </style></head><body>
          <div class="logo">\(logo)</div>
          <div class="title">Hitch</div>
          <div>\(escaped)</div>
          \(spinning ? "<div class=\"spinner\" aria-hidden=\"true\"></div>" : "")
        </body></html>
        """
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
