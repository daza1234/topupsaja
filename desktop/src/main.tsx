import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { installHostTauri } from "./lib/host-tauri";
import "./index.css";

async function bootstrap() {
  await installHostTauri();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

bootstrap().catch((e) => {
  document.getElementById("root")!.textContent = `Gagal memulai aplikasi: ${e}`;
});