window.__ModuleLoader__.load({ id: "dsh-preview-plugin", factory: (require) => { var module = { exports: {} }; var exports = module.exports; Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const { useState, useRef, useCallback, useEffect, createElement: h } = require("react");

		const inject = ["slots"];
		const STORAGE_KEY = "dsh.preview.port";
		const STORAGE_KEY_BP = "dsh.preview.backendPorts";
		const POLL_MS = 5000;
		const SYNC_MS = 1000;

		/** "/preview/<port>/<path>" for a port and an in-preview path. */
		function previewPathFor(port, path) {
			if (!port) return "";
			var suffix = path || "/";
			if (suffix.charAt(0) !== "/") suffix = "/" + suffix;
			return "/preview/" + port + suffix;
		}

		function parseBackendPorts(raw) {
			if (!raw) return [];
			return raw.split(",").map(function(s) { return s.trim(); }).filter(function(s) { return /^\d{1,5}$/.test(s); });
		}

		function isLocalHostname(host) {
			return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host === "[::1]";
		}

		/** Split a "/preview/<port>/<rest>" pathname (proxy path of any origin). */
		function matchPreviewPath(pathname) {
			var m = /^\/preview\/(\d{1,5})(\/[\s\S]*)?$/.exec(pathname || "");
			if (!m) return null;
			return { port: m[1], path: m[2] || "/" };
		}

		/** The in-preview path behind a proxy path: "/preview/4321/x?y" → "/x". */
		function inPreviewPath(path, port) {
			var pathname = String(path || "/").split(/[?#]/)[0];
			if (port) {
				var own = new RegExp("^/preview/" + port + "(/.*)?$").exec(pathname);
				if (own) return own[1] || "/";
			}
			var preview = matchPreviewPath(pathname);
			return preview ? preview.path : pathname;
		}

		/**
		 * What the user typed in the address bar → { port, path } or { error }.
		 *
		 *   "4321"                              → port 4321, root
		 *   "4321/laptops"                      → port 4321, /laptops
		 *   "/laptops?page=2"                   → current port, that path
		 *   "laptops"                           → current port, /laptops
		 *   "?page=2" / "#specs"                → current port, current path + suffix
		 *   "/preview/4321/laptops"             → as-is
		 *   "http://localhost:4321/laptops"     → port 4321, /laptops
		 *   "http://host:3080/preview/4321/x"   → port 4321, /x (a preview URL)
		 */
		function resolveTarget(raw, currentPort, currentPath) {
			var input = String(raw === null || raw === undefined ? "" : raw).trim();
			if (!input) return { error: "Enter a port, a path or a URL" };
			if (/^https?:\/\//i.test(input)) {
				var u;
				try { u = new URL(input); } catch (e) { return { error: "Invalid URL" }; }
				var preview = matchPreviewPath(u.pathname);
				if (preview) return { port: preview.port, path: preview.path + u.search + u.hash };
				if (isLocalHostname(u.hostname) && /^\d{1,5}$/.test(u.port)) {
					return { port: u.port, path: (u.pathname || "/") + u.search + u.hash };
				}
				var selfHost = (typeof window !== "undefined" && window.location) ? window.location.host : "";
				if (selfHost && u.host === selfHost && currentPort) {
					return { port: currentPort, path: (u.pathname || "/") + u.search + u.hash };
				}
				return { error: "Only local dev servers can be previewed" };
			}
			if (/^\d{1,5}$/.test(input)) return { port: input, path: "/" };
			var withPath = /^(\d{1,5})\/([\s\S]*)$/.exec(input);
			if (withPath) return { port: withPath[1], path: "/" + withPath[2] };
			var proxyPath = /^\/?preview\/(\d{1,5})(\/[\s\S]*)?$/.exec(input);
			if (proxyPath) return { port: proxyPath[1], path: proxyPath[2] || "/" };
			if (!currentPort) return { error: "Set the preview port first (e.g. 4321)" };
			if (input.charAt(0) === "?" || input.charAt(0) === "#") {
				return { port: currentPort, path: inPreviewPath(currentPath, currentPort) + input };
			}
			return { port: currentPort, path: input.charAt(0) === "/" ? input : "/" + input };
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
			var [urlInput, setUrlInput] = useState(function () { return port ? previewPathFor(port, "/") : ""; });
			var [bpInput, setBpInput] = useState(backendPortsRaw);
			var [src, setSrc] = useState(function () { return port ? previewPathFor(port, "/") : ""; });
			var [error, setError] = useState("");
			var [notice, setNotice] = useState("");
			var iframeRef = useRef(null);
			var urlRef = useRef(null);
			var pollRef = useRef(null);

			/** Path currently loaded in the iframe, or null when it is not reachable. */
			var readIframePath = useCallback(function () {
				try {
					var frame = iframeRef.current;
					if (!frame || !frame.contentWindow) return null;
					var loc = frame.contentWindow.location;
					return loc.pathname + loc.search + loc.hash;
				} catch (e) { return null; }
			}, []);

			/** Follow the iframe: clicking inside it must update the address bar. */
			var syncUrlField = useCallback(function () {
				var current = readIframePath();
				if (!current) return;
				// An app can leave the proxy by assigning location.href: that property
				// is a non-configurable own property of the location object, so no
				// interceptor can rewrite it. Without this the iframe would silently
				// show the DSH app instead of the previewed one.
				if (port && current.indexOf("/preview/") !== 0) {
					var recovered = previewPathFor(port, current);
					setSrc(recovered);
					setUrlInput(recovered);
					setNotice("That page tried to leave the preview (location.href); it was opened under the proxy.");
					return;
				}
				var el = urlRef.current;
				if (el && document.activeElement === el) return;
				setUrlInput(function (prev) { return prev === current ? prev : current; });
			}, [readIframePath, port]);

			var navigate = useCallback(function (nextSrc) {
				if (!nextSrc) return;
				if (nextSrc === src) {
					// React will not touch an unchanged attribute, so move the iframe
					// itself — its real location may differ from the last src we set.
					try {
						var frame = iframeRef.current;
						if (frame && frame.contentWindow && readIframePath() !== nextSrc) {
							frame.contentWindow.location.href = nextSrc;
						}
					} catch (e) {}
				} else {
					setSrc(nextSrc);
				}
				setUrlInput(nextSrc);
			}, [src, readIframePath]);

			var applyTargets = useCallback(function () {
				var target = resolveTarget(urlInput, port, readIframePath());
				if (target.error) { setError(target.error); return; }
				setError("");
				setNotice("");
				var bp = parseBackendPorts(bpInput);
				setPort(target.port);
				setBackendPortsRaw(bpInput);
				try { localStorage.setItem(STORAGE_KEY, target.port); } catch {}
				try { localStorage.setItem(STORAGE_KEY_BP, bpInput); } catch {}
				// Keep the agent/host side in step with what the user is previewing.
				try {
					var loc = window.location;
					var base = loc.protocol + "//" + loc.host;
					fetch(base + "/api/preview-port", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ port: target.port, backendPorts: bp }),
					});
				} catch {}
				navigate(previewPathFor(target.port, target.path));
			}, [urlInput, bpInput, port, readIframePath, navigate]);

			var onFieldKeyDown = useCallback(function (e) {
				if (e.key === "Enter") { e.preventDefault(); applyTargets(); }
			}, [applyTargets]);

			var reload = useCallback(function () {
				var frame = iframeRef.current;
				if (!frame) return;
				try {
					frame.contentWindow.location.reload();
				} catch (e) {
					if (src) frame.src = src;
				}
			}, [src]);

			var openInTab = useCallback(function () {
				var path = readIframePath() || (port ? previewPathFor(port, "/") : "");
				if (!path) return;
				var loc = window.location;
				window.open(loc.protocol + "//" + loc.host + path, "_blank", "noopener");
			}, [port, readIframePath]);

			useEffect(function () {
				if (!port) return;
				var id = setInterval(syncUrlField, SYNC_MS);
				return function () { clearInterval(id); };
			}, [port, syncUrlField]);

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
										var next = previewPathFor(p, "/");
										setPort(p);
										setUrlInput(next);
										setSrc(next);
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
			var inputStyle = { flex: "2 1 220px", minWidth: "180px", padding: "6px 10px", borderRadius: "6px", border: "1px solid #475569", background: "#0f172a", color: "#e2e8f0", fontSize: "13px", fontFamily: "monospace", outline: "none" };
			var bpInputStyle = { flex: "1 1 120px", minWidth: "120px", padding: "6px 10px", borderRadius: "6px", border: "1px solid #475569", background: "#0f172a", color: "#e2e8f0", fontSize: "13px", fontFamily: "monospace", outline: "none" };
			var labelStyle = { color: "#94a3b8", fontSize: "11px", whiteSpace: "nowrap" };
			var goBtnStyle = { padding: "6px 12px", borderRadius: "6px", border: "none", background: "#3b82f6", color: "white", fontSize: "13px", cursor: "pointer" };
			var refreshBtnStyle = { padding: "6px 12px", borderRadius: "6px", border: "none", background: "#475569", color: "white", fontSize: "13px", cursor: "pointer" };

			var bpList = parseBackendPorts(backendPortsRaw);
			var statusText = "Frontend: " + port;
			if (bpList.length > 0) statusText += " | Backend: " + bpList.join(", ");

			var statusStyle = { display: "flex", alignItems: "center", gap: "6px", padding: "4px 12px", background: "#1e293b", borderBottom: "1px solid #334155", fontSize: "11px", color: "#64748b" };
			var dotGreen = { width: "6px", height: "6px", borderRadius: "50%", background: "#22c55e", display: "inline-block", flex: "none" };

			var absoluteUrl = "";
			if (port) {
				var loc = window.location;
				var shown = /^\/preview\//.test(urlInput) ? urlInput : previewPathFor(port, "/");
				absoluteUrl = loc.protocol + "//" + loc.host + shown;
			}

			var toolbar = h("div", { style: toolbarStyle },
				h("span", { style: labelStyle }, "URL"),
				h("input", {
					ref: urlRef,
					style: inputStyle,
					value: urlInput,
					onChange: function (e) { setUrlInput(e.target.value); },
					onKeyDown: onFieldKeyDown,
					spellCheck: false,
					placeholder: "port, path or URL (e.g. 4321, /laptops)",
					title: "Port, path or URL of the page to preview. Enter to load.",
				}),
				h("span", { style: labelStyle }, "Backend"),
				h("input", {
					style: bpInputStyle,
					value: bpInput,
					onChange: function (e) { setBpInput(e.target.value); },
					onKeyDown: onFieldKeyDown,
					spellCheck: false,
					placeholder: "ports (e.g. 3001, 3002)",
					title: "Comma-separated backend ports proxied through the same iframe",
				}),
				h("button", { style: goBtnStyle, onClick: applyTargets, title: "Load this URL" }, "Go"),
				h("button", { style: refreshBtnStyle, onClick: reload, title: "Reload the preview" }, "\u21bb"),
				h("button", { style: refreshBtnStyle, onClick: openInTab, title: "Open this URL in a new tab" }, "\u2197"),
			);

			var status = port ? h("div", { style: statusStyle },
				h("span", { style: dotGreen }),
				h("span", { style: { flex: "none" } }, statusText),
				h("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#475569" }, title: absoluteUrl }, absoluteUrl),
			) : null;

			var message = error
				? h("div", { style: { display: "flex", alignItems: "center", gap: "6px", padding: "4px 12px", background: "#7f1d1d", color: "#fecaca", fontSize: "11px" } }, error)
				: notice
					? h("div", { style: { display: "flex", alignItems: "center", gap: "6px", padding: "4px 12px", background: "#78350f", color: "#fde68a", fontSize: "11px" } }, notice)
					: null;

			return h("div", { style: { display: "flex", flexDirection: "column", height: "100%" } },
				toolbar,
				status,
				message,
				!port ? h("div", { style: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b", flexDirection: "column", gap: "8px" } },
					h("div", { style: { fontSize: "2rem" } }, "\ud83c\udf10"),
					h("div", null, "Enter a port number to preview"),
					h("div", { style: { fontSize: "12px", color: "#475569" } }, "Tip: start your dev server with --host 0.0.0.0"),
				) : h("iframe", {
					ref: iframeRef,
					src: src,
					onLoad: syncUrlField,
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
		exports.__internals = {
			previewPathFor: previewPathFor,
			parseBackendPorts: parseBackendPorts,
			matchPreviewPath: matchPreviewPath,
			inPreviewPath: inPreviewPath,
			resolveTarget: resolveTarget,
		};
		return module.exports;
	}
});
