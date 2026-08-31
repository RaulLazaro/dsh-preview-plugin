window.__ModuleLoader__.load({
	id: "dsh-preview-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const { useState, useRef, useCallback, useEffect } = require("react");
		const { jsx, jsxs } = require("react/jsx-runtime");

		const inject = ["slots"];

		const STORAGE_KEY = "dsh.preview.url";

		function PreviewView(props) {
			const [url, setUrl] = useState(() => {
				try { return localStorage.getItem(STORAGE_KEY) || ""; }
				catch { return ""; }
			});
			const [input, setInput] = useState(url);
			const iframeRef = useRef(null);
			const [loading, setLoading] = useState(false);
			const [error, setError] = useState(null);

			const applyUrl = useCallback(() => {
				const trimmed = input.trim();
				if (!trimmed) return;
				setUrl(trimmed);
				setError(null);
				setLoading(true);
				try { localStorage.setItem(STORAGE_KEY, trimmed); } catch {}
			}, [input]);

			const refresh = useCallback(() => {
				if (!url || !iframeRef.current) return;
				setLoading(true);
				setError(null);
				iframeRef.current.src = url;
			}, [url]);

			useEffect(() => {
				const handler = (e) => {
					if (e.key === "Enter" && document.activeElement?.dataset?.previewInput !== undefined) {
						applyUrl();
					}
				};
				document.addEventListener("keydown", handler);
				return () => document.removeEventListener("keydown", handler);
			}, [applyUrl]);

			const barStyle = {
				display: "flex",
				gap: "8px",
				padding: "8px 12px",
				background: "#1e293b",
				borderBottom: "1px solid #334155",
				alignItems: "center",
			};

			const inputStyle = {
				flex: 1,
				padding: "6px 10px",
				borderRadius: "6px",
				border: "1px solid #475569",
				background: "#0f172a",
				color: "#e2e8f0",
				fontSize: "13px",
				fontFamily: "monospace",
				outline: "none",
			};

			const btnStyle = {
				padding: "6px 12px",
				borderRadius: "6px",
				border: "none",
				background: "#3b82f6",
				color: "white",
				fontSize: "13px",
				cursor: "pointer",
				whiteSpace: "nowrap",
			};

			const refreshBtn = {
				...btnStyle,
				background: "#475569",
			};

			return jsxs("div", { style: { display: "flex", flexDirection: "column", height: "100%" } },
				jsxs("div", { style: barStyle },
					jsx("input", {
						style: inputStyle,
						value: input,
						onChange: (e) => setInput(e.target.value),
						placeholder: "http://<ip-vps>:3000",
						"data-preview-input": "1",
					}),
					jsx("button", { style: btnStyle, onClick: applyUrl }, "Go"),
					jsx("button", { style: refreshBtn, onClick: refresh }, "↻"),
				),
				error && jsx("div", {
					style: { padding: "8px 12px", background: "#7f1d1d", color: "#fca5a5", fontSize: "13px" }
				}, error),
				!url ? jsx("div", {
					style: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b", flexDirection: "column", gap: "8px" }
				},
					jsx("div", { style: { fontSize: "2rem" } }, "🌐"),
					jsx("div", null, "Enter a URL above to preview your project"),
					jsx("div", { style: { fontSize: "12px", color: "#475569" } }, "Tip: use 0.0.0.0 when starting the dev server")
				) : jsx("iframe", {
					ref: iframeRef,
					src: url,
					style: { flex: 1, border: "none", width: "100%" },
					onLoad: () => setLoading(false),
					onError: () => { setLoading(false); setError("Failed to load — check the URL and ensure the server is running on 0.0.0.0"); },
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
