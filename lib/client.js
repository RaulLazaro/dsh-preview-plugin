window.__ModuleLoader__.load({ id: "dsh-preview-plugin", factory: (require) => { var module = { exports: {} }; var exports = module.exports; Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const { useState, useRef, useCallback, useEffect, createElement: h } = require("react");

		const inject = ["slots"];
		const STORAGE_KEY = "dsh.preview.url";

		function proxyUrl(target) {
			if (!target) return "";
			try {
				var loc = window.location;
				return loc.protocol + "//" + loc.host + "/api/preview-proxy?url=" + encodeURIComponent(target);
			} catch { return target; }
		}

		function PreviewView(props) {
			const [url, setUrl] = useState(() => {
				try { return localStorage.getItem(STORAGE_KEY) || ""; }
				catch { return ""; }
			});
			const [input, setInput] = useState(url);
			const iframeRef = useRef(null);

			const applyUrl = useCallback(() => {
				const trimmed = input.trim();
				if (!trimmed) return;
				setUrl(trimmed);
				try { localStorage.setItem(STORAGE_KEY, trimmed); } catch {}
			}, [input]);

			useEffect(() => {
				const handler = (e) => {
					if (e.key === "Enter" && document.activeElement?.dataset?.previewInput !== undefined) {
						applyUrl();
					}
				};
				document.addEventListener("keydown", handler);
				return () => document.removeEventListener("keydown", handler);
			}, [applyUrl]);

			const toolbarStyle = { display: "flex", gap: "8px", padding: "8px 12px", background: "#1e293b", borderBottom: "1px solid #334155", alignItems: "center" };
			const inputStyle = { flex: 1, padding: "6px 10px", borderRadius: "6px", border: "1px solid #475569", background: "#0f172a", color: "#e2e8f0", fontSize: "13px", fontFamily: "monospace", outline: "none" };
			const goBtnStyle = { padding: "6px 12px", borderRadius: "6px", border: "none", background: "#3b82f6", color: "white", fontSize: "13px", cursor: "pointer" };
			const refreshBtnStyle = { padding: "6px 12px", borderRadius: "6px", border: "none", background: "#475569", color: "white", fontSize: "13px", cursor: "pointer" };

			return h("div", { style: { display: "flex", flexDirection: "column", height: "100%" } },
				h("div", { style: toolbarStyle },
					h("input", {
						style: inputStyle,
						value: input,
						onChange: (e) => setInput(e.target.value),
						placeholder: "http://<ip-vps>:8099",
						"data-preview-input": "1",
					}),
					h("button", { style: goBtnStyle, onClick: applyUrl }, "Go"),
					h("button", { style: refreshBtnStyle, onClick: () => { if (iframeRef.current) iframeRef.current.src = proxyUrl(url); } }, "\u21bb"),
				),
				!url ? h("div", { style: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b", flexDirection: "column", gap: "8px" } },
					h("div", { style: { fontSize: "2rem" } }, "\ud83c\udf10"),
					h("div", null, "Enter a URL above to preview your project"),
				) : h("iframe", {
					ref: iframeRef,
					src: proxyUrl(url),
					style: { flex: 1, border: "none", width: "100%" },
					sandbox: "allow-scripts allow-same-origin allow-forms allow-popups",
				}),
			);
		}

		function apply(ctx) {
			ctx.slots.inject("conversation.view", () => ctx.slots.register({
				name: "conversation.view",
				id: "preview",
				order: 20,
				label: () => "Preview",
				inject: (sessionId) => ({ sessionId }),
			}, PreviewView));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
