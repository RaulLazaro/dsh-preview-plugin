window.__ModuleLoader__.load({ id: "dsh-preview-plugin", factory: (require) => { var module = { exports: {} }; var exports = module.exports; Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const { useState, useRef, useCallback, useEffect, createElement: h } = require("react");

		const inject = ["slots"];
		const STORAGE_KEY = "dsh.preview.port";
		const STORAGE_KEY_BP = "dsh.preview.backendPorts";
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

		function parseBackendPorts(raw) {
			if (!raw) return [];
			return raw.split(",").map(function(s) { return s.trim(); }).filter(function(s) { return /^\d{1,5}$/.test(s); });
		}

		function PreviewView(props) {
			var sessionId = props && props.sessionId;
			var [port, setPort] = useState(function () {
				try { return localStorage.getItem(STORAGE_KEY) || ""; }
				catch { return ""; }
			});
			var [backendPortsRaw, setBackendPortsRaw] = useState(function () {
				try { return localStorage.getItem(STORAGE_KEY_BP) || ""; }
				catch { return ""; }
			});
			var [input, setInput] = useState(port);
			var [bpInput, setBpInput] = useState(backendPortsRaw);
			var iframeRef = useRef(null);
			var pollRef = useRef(null);

			var applyPort = useCallback(function () {
				var resolved = resolvePort(input);
				if (!resolved) return;
				var bp = parseBackendPorts(bpInput);
				setPort(resolved);
				setInput(resolved);
				setBackendPortsRaw(bpInput);
				try { localStorage.setItem(STORAGE_KEY, resolved); } catch {}
				try { localStorage.setItem(STORAGE_KEY_BP, bpInput); } catch {}
				// Notify server about port and backend ports
				try {
					var loc = window.location;
					var base = loc.protocol + "//" + loc.host;
					fetch(base + "/api/preview-port", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ port: resolved, backendPorts: bp }),
					});
				} catch {}
			}, [input, bpInput]);

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
								if (data && Array.isArray(data.backendPorts)) {
									var bpStr = data.backendPorts.join(", ");
									if (bpStr !== backendPortsRaw) {
										setBackendPortsRaw(bpStr);
										setBpInput(bpStr);
										try { localStorage.setItem(STORAGE_KEY_BP, bpStr); } catch {}
									}
								}
							})
							.catch(function () {});
					} catch {}
				};
				check();
				pollRef.current = setInterval(check, POLL_MS);
				return function () { clearInterval(pollRef.current); };
			}, [sessionId, port, backendPortsRaw]);

			var toolbarStyle = { display: "flex", gap: "8px", padding: "8px 12px", background: "#1e293b", borderBottom: "1px solid #334155", alignItems: "center", flexWrap: "wrap" };
			var inputStyle = { flex: 1, minWidth: "120px", padding: "6px 10px", borderRadius: "6px", border: "1px solid #475569", background: "#0f172a", color: "#e2e8f0", fontSize: "13px", fontFamily: "monospace", outline: "none" };
			var bpInputStyle = { flex: 1, minWidth: "180px", padding: "6px 10px", borderRadius: "6px", border: "1px solid #475569", background: "#0f172a", color: "#e2e8f0", fontSize: "13px", fontFamily: "monospace", outline: "none" };
			var labelStyle = { color: "#94a3b8", fontSize: "11px", whiteSpace: "nowrap" };
			var goBtnStyle = { padding: "6px 12px", borderRadius: "6px", border: "none", background: "#3b82f6", color: "white", fontSize: "13px", cursor: "pointer" };
			var refreshBtnStyle = { padding: "6px 12px", borderRadius: "6px", border: "none", background: "#475569", color: "white", fontSize: "13px", cursor: "pointer" };

			var iframeSrc = port ? proxyUrl(port) : "";

			var statusStyle = { display: "flex", alignItems: "center", gap: "6px", padding: "4px 12px", background: "#1e293b", borderBottom: "1px solid #334155", fontSize: "11px", color: "#64748b" };
			var dotGreen = { width: "6px", height: "6px", borderRadius: "50%", background: "#22c55e", display: "inline-block" };

			var bpList = parseBackendPorts(backendPortsRaw);
			var statusText = "Frontend: " + port;
			if (bpList.length > 0) statusText += " | Backend: " + bpList.join(", ");

			return h("div", { style: { display: "flex", flexDirection: "column", height: "100%" } },
				h("div", { style: toolbarStyle },
					h("span", { style: labelStyle }, "Frontend:"),
					h("input", {
						style: inputStyle,
						value: input,
						onChange: function (e) { setInput(e.target.value); },
						placeholder: "port (e.g. 4321)",
						"data-preview-input": "1",
					}),
					h("span", { style: labelStyle }, "Backend:"),
					h("input", {
						style: bpInputStyle,
						value: bpInput,
						onChange: function (e) { setBpInput(e.target.value); },
						placeholder: "ports (e.g. 3001, 3002)",
						"data-preview-input": "1",
					}),
					h("button", { style: goBtnStyle, onClick: applyPort }, "Go"),
					h("button", { style: refreshBtnStyle, onClick: function () { if (iframeRef.current && port) iframeRef.current.src = proxyUrl(port); } }, "\u21bb"),
				),
				port ? h("div", { style: statusStyle },
					h("span", { style: dotGreen }),
					h("span", null, statusText),
				) : null,
				!port ? h("div", { style: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b", flexDirection: "column", gap: "8px" } },
					h("div", { style: { fontSize: "2rem" } }, "\ud83c\udf10"),
					h("div", null, "Enter a port number to preview"),
					h("div", { style: { fontSize: "12px", color: "#475569" } }, "Tip: start your dev server with --host 0.0.0.0"),
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
