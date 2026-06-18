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
// zustand/persist hydrates synchronously from localStorage on store creation,
// so getState().theme is already the user's choice here.
function applyTheme() {
  document.documentElement.setAttribute("data-theme", useSettings.getState().theme);
}
applyTheme();
useSettings.subscribe((s) => {
  if (document.documentElement.getAttribute("data-theme") !== s.theme) applyTheme();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
