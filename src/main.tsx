import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { theme } from "@/lib/theme";

theme.init();

// Only the disposable builds that prove the update path set this. It presses the same
// buttons a person would, where there's no WebDriver to do it (macOS).
if (import.meta.env.VITE_PEAK_E2E_AUTOUPDATE) {
  void import("@/lib/update-proof").then((m) => {
    m.recordProofFailures();
    (function pass() {
      void m.updateProofPass().finally(() => setTimeout(pass, 3000));
    })();
  });
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
