import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { useSettings } from "./store/settings";
import "katex/dist/katex.min.css";
import "./index.css";

// NOTE: React.StrictMode is intentionally disabled. It double-mounts effects in
// dev, which aborts in-flight streaming fetches (the LLM SSE stream) on the
// second mount — the tool-calling loop's second round tripped ERR_ABORTED.

// Apply the persisted theme ASAP to avoid a flash of the wrong colorscheme.
// The settings store no longer hydrates synchronously (it loads from the
// backend on login), so read the last-known theme from a tiny localStorage
// cache written by the settings store on hydrate. Falls back to the default.
function applyTheme() {
  let theme = "default";
  try { theme = localStorage.getItem("lax-theme") || "default"; } catch { /* ignore */ }
  document.documentElement.setAttribute("data-theme", theme);
}
applyTheme();
useSettings.subscribe((s) => {
  if (document.documentElement.getAttribute("data-theme") !== s.theme) {
    document.documentElement.setAttribute("data-theme", s.theme);
  }
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
