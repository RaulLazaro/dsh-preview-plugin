window.__ModuleLoader__.load({ id: "dsh-preview-plugin", factory: (require) => { var module = { exports: {} }; var exports = module.exports; Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const { useState, useRef, useCallback, useEffect, createElement: h } = require("react");

		const inject = ["slots"];
		const STORAGE_KEY = "dsh.preview.port";
		const POLL_MS = 5000;

		function resolvePort(raw) {
			if (!raw) return "";
			var trimmed = raw.trim();
			if (/^\d{1,5}$/.test(trimmed)) return trimmed;
			try {
				var u = new URL(trimmed);
				if (u.port) return u.port;
			} catch {}
			return "";
		}

		function proxyUrl(port) {
			if (!port) return "";
			try {
				var loc = window.location;
				return loc.protocol + "//" + loc.host + "/preview/" + port + "/";
			} catch { return "/preview/" + port + "/"; }
		}

		function PreviewView(props) {
			var sessionId = props && props.sessionId;
			var [port, setPort] = useState(function () {
				try { return localStorage.getItem(STORAGE_KEY) || ""; }
				catch { return ""; }
			});
			var [input, setInput] = useState(port);
			var iframeRef = useRef(null);
			var pollRef = useRef(null);

			var applyPort = useCallback(function () {
				var resolved = resolvePort(input);
				if (!resolved) return;
				setPort(resolved);
				setInput(resolved);
				try { localStorage.setItem(STORAGE_KEY, resolved); } catch {}
			}, [input]);

			useEffect(function () {
				var handler = function (e) {
					if (e.key === "Enter" && document.activeElement && document.activeElement.dataset && document.activeElement.dataset.previewInput !== undefined) {
						applyPort();
					}
				};
				document.addEventListener("keydown", handler);
				return function () { document.removeEventListener("keydown", handler); };
			}, [applyPort]);

			// Poll host for agent-set port
			useEffect(function () {
				if (!sessionId) return;
				var check = function () {
					try {
						var loc = window.location;
						var base = loc.protocol + "//" + loc.host;
						fetch(base + "/api/preview-port?sessionId=" + encodeURIComponent(sessionId))
							.then(function (r) { return r.json(); })
							.then(function (data) {
								if (data && data.port) {
									var p = String(data.port);
									if (p !== port) {
										setPort(p);
										setInput(p);
										try { localStorage.setItem(STORAGE_KEY, p); } catch {}
									}
								}
							})
							.catch(function () {});
					} catch {}
				};
				check();
				pollRef.current = setInterval(check, POLL_MS);
				return function () { clearInterval(pollRef.current); };
			}, [sessionId, port]);

			var toolbarStyle = { display: "flex", gap: "8px", padding: "8px 12px", background: "#1e293b", borderBottom: "1px solid #334155", alignItems: "center" };
			var inputStyle = { flex: 1, padding: "6px 10px", borderRadius: "6px", border: "1px solid #475569", background: "#0f172a", color: "#e2e8f0", fontSize: "13px", fontFamily: "monospace", outline: "none" };
			var goBtnStyle = { padding: "6px 12px", borderRadius: "6px", border: "none", background: "#3b82f6", color: "white", fontSize: "13px", cursor: "pointer" };
			var refreshBtnStyle = { padding: "6px 12px", borderRadius: "6px", border: "none", background: "#475569", color: "white", fontSize: "13px", cursor: "pointer" };

			var iframeSrc = port ? proxyUrl(port) : "";

			return h("div", { style: { display: "flex", flexDirection: "column", height: "100%" } },
				h("div", { style: toolbarStyle },
					h("input", {
						style: inputStyle,
						value: input,
						onChange: function (e) { setInput(e.target.value); },
						placeholder: "port (e.g. 3000)",
						"data-preview-input": "1",
					}),
					h("button", { style: goBtnStyle, onClick: applyPort }, "Go"),
					h("button", { style: refreshBtnStyle, onClick: function () { if (iframeRef.current && port) iframeRef.current.src = proxyUrl(port); } }, "\u21bb"),
				),
				!port ? h("div", { style: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b", flexDirection: "column", gap: "8px" } },
					h("div", { style: { fontSize: "2rem" } }, "\ud83c\udf10"),
					h("div", null, "Enter a port number to preview"),
				) : h("iframe", {
					ref: iframeRef,
					src: iframeSrc,
					style: { flex: 1, border: "none", width: "100%" },
					sandbox: "allow-scripts allow-same-origin allow-forms allow-popups",
				}),
			);
		}

		function apply(ctx) {
			ctx.slots.inject("conversation.view", function () { return ctx.slots.register({
				name: "conversation.view",
				id: "preview",
				order: 20,
				label: function () { return "Preview"; },
				inject: function (sessionId) { return { sessionId: sessionId }; },
			}, PreviewView); });
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
