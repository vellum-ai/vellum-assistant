import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App.js";

import "./styles.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Eli HUD: missing #root element");
}

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
