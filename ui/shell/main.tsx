import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../src/styles.css";
import "./shell.css";
import { App } from "./App";
import { createHttpClient } from "./http-client";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App client={createHttpClient()} />
  </StrictMode>,
);
