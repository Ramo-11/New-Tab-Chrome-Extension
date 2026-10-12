import { useEffect } from "react";
import { SandpackLayout, SandpackPreview, SandpackProvider } from "@codesandbox/sandpack-react";

const OPEN_LINK = "hb-open-link";

const INDEX_JS = `import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

document.addEventListener(
  "click",
  (event) => {
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!anchor || !/^https?:/i.test(anchor.href)) return;
    event.preventDefault();
    const newTab = event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1;
    window.parent.postMessage({ type: "${OPEN_LINK}", url: anchor.href, newTab }, "*");
  },
  true,
);

document.addEventListener(
  "auxclick",
  (event) => {
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!anchor || event.button !== 1 || !/^https?:/i.test(anchor.href)) return;
    event.preventDefault();
    window.parent.postMessage({ type: "${OPEN_LINK}", url: anchor.href, newTab: true }, "*");
  },
  true,
);

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);`;

const INDEX_HTML = `<!DOCTYPE html>
<html><head><title>My Personalized Homepage</title><base target="_blank"></head>
<body><div id="root"></div></body></html>`;

function isFromPreview(source: MessageEventSource | null): boolean {
  if (!source) return false;
  return [...document.querySelectorAll("iframe")].some((frame) => frame.contentWindow === source);
}

function useLinkOpener() {
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; url?: unknown; newTab?: unknown } | null;
      if (data?.type !== OPEN_LINK || typeof data.url !== "string" || !isFromPreview(event.source)) return;
      let url: URL;
      try {
        url = new URL(data.url);
      } catch {
        return;
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") return;
      if (data.newTab === true) void browser.tabs.create({ url: url.href, active: false });
      else window.location.assign(url.href);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
}

export function HomepagePreview({ code }: { code: string }) {
  useLinkOpener();

  const files = {
    "/App.js": { code },
    "/index.js": { code: INDEX_JS },
    "/index.html": { code: INDEX_HTML },
  };

  return (
    <SandpackProvider files={files} template="react" options={{ autorun: true }}>
      <SandpackLayout style={{ height: "100%", width: "100%", border: "none", borderRadius: 0 }}>
        <SandpackPreview style={{ height: "100%" }} showOpenInCodeSandbox={false} showRefreshButton={false} />
      </SandpackLayout>
    </SandpackProvider>
  );
}
