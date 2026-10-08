import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";

async function boot() {
  // Outside the Tauri app (a plain browser during development) there is no
  // backend, so a mock one stands in. Builds never include it.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    await import("./dev/mock");
    const { useStore } = await import("./store");
    const { useUi } = await import("./ui");
    const { usePanel } = await import("./panelStore");
    Object.assign(window, { __store: useStore, __ui: useUi, __panel: usePanel });
  }
  const { default: App } = await import("./App");
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void boot();
