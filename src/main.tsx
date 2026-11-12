import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { I18nProvider } from "./i18n";
import "./index.css";

const windowLabel = getCurrentWindow().label;
if (windowLabel === "output" || windowLabel === "overflow") {
  document.documentElement.classList.add("audience-cursor-none");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <ErrorBoundary windowLabel="root">
        <App />
      </ErrorBoundary>
    </I18nProvider>
  </React.StrictMode>
);
