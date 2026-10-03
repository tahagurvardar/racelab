// DEV-ONLY brand reference sheet. Renders the final mark and wordmark from
// the same components the application uses, at the sizes and on the
// surfaces where they actually appear, in colour and in one colour, beside
// the packaged icon rendered from src-tauri/icons/icon.svg. For release QA.
import "./dev-only.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppMark, VersionLabel, Wordmark } from "../src/components/brand/Brand";
import { Icon } from "../src/components/shell/Icon";
import "../src/styles/tokens.css";
import "../src/styles/fonts.css";
import "../src/styles/base.css";
import "../src/styles/shell.css";
import "./brand.css";

const SIZES = [16, 20, 24, 32, 48, 64];

function SidebarPreview() {
  return (
    <div className="preview-sidebar">
      <div className="sidebar-brand">
        <AppMark size={24} />
        <span className="sidebar-wordmark">
          <Wordmark />
        </span>
      </div>
      {(["live", "sessions", "settings"] as const).map((id, index) => (
        <div
          key={id}
          className={`sidebar-item${index === 0 ? " is-active" : ""}`}
        >
          <Icon name={id} />
          <span className="sidebar-item-label">
            {id[0].toUpperCase() + id.slice(1)}
          </span>
        </div>
      ))}
      <div className="preview-version">
        <VersionLabel />
      </div>
    </div>
  );
}

function RailPreview() {
  return (
    <div className="preview-rail">
      <AppMark size={24} />
      <span className="preview-rail-item is-active">
        <Icon name="live" />
      </span>
      <span className="preview-rail-item">
        <Icon name="sessions" />
      </span>
    </div>
  );
}

function Sizes({ mono, surface }: { mono?: boolean; surface: string }) {
  return (
    <div className={`sizes ${surface}`}>
      {SIZES.map((size) => (
        <figure key={size}>
          <AppMark size={size} mono={mono} />
          <figcaption>{size}</figcaption>
        </figure>
      ))}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <main className="sheet">
      <h1>RaceLab — brand reference</h1>
      <p className="sheet-note">
        Final mark and wordmark, as the application renders them (inline SVG and
        live type). The packaged icons are rendered from the same geometry.
      </p>

      <section className="block">
        <h2>In the shell</h2>
        <div className="row">
          <SidebarPreview />
          <RailPreview />
          <div className="titlebar">
            <img src="/src-tauri/icons/32x32.png" width={16} height={16} />
            <span>RaceLab</span>
          </div>
          <div className="titlebar is-light">
            <img src="/src-tauri/icons/32x32.png" width={16} height={16} />
            <span>RaceLab</span>
          </div>
        </div>
      </section>

      <section className="block">
        <h2>Mark · colour</h2>
        <Sizes surface="on-app" />
        <Sizes surface="on-panel" />
      </section>

      <section className="block">
        <h2>Mark · one colour</h2>
        <Sizes mono surface="on-app" />
        <Sizes mono surface="on-light" />
      </section>

      <section className="block">
        <h2>Packaged icon</h2>
        <div className="sizes on-app">
          {[16, 32, 64, 128].map((size) => (
            <figure key={size}>
              <img
                src="/src-tauri/icons/icon.png"
                width={size}
                height={size}
                alt=""
              />
              <figcaption>{size}</figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section className="block">
        <h2>Wordmark</h2>
        <div className="wordmarks">
          {[14, 16, 24, 32, 44].map((size) => (
            <p key={size} style={{ fontSize: `${size}px` }}>
              <Wordmark />
            </p>
          ))}
        </div>
      </section>
    </main>
  </StrictMode>,
);
