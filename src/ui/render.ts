import { h, VNode } from "preact";
import { render as preactRender } from "preact-render-to-string";
import { setup, extractCss } from "goober";

// Initialize goober
setup(h);

/**
 * Render a Preact component to HTML string with styles
 */
export function renderToHtml(component: VNode): { html: string; css: string } {
  // Reset CSS extraction
  extractCss(); // Clear any previous styles
  
  const html = preactRender(component);
  const css = extractCss();
  
  return { html, css };
}

/**
 * Create a full HTML document with the rendered component
 */
export function renderDocument(
  component: VNode,
  options: {
    title?: string;
    scripts?: string[];
    mermaidEnabled?: boolean;
  } = {}
): string {
  const { title = "Repomap", scripts = [], mermaidEnabled = true } = options;
  const { html, css } = renderToHtml(component);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>${css}</style>
  ${mermaidEnabled ? '<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>' : ''}
</head>
<body>
  ${html}
  ${mermaidEnabled ? '<script>mermaid.initialize({ startOnLoad: true, theme: "neutral" });</script>' : ''}
  ${scripts.map((s) => `<script>${s}</script>`).join("\n")}
</body>
</html>`;
}
