export class Html {
  constructor(readonly value: string) {}
  toString() {
    return this.value;
  }
}

export function esc(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? '';
  values.forEach((v, i) => {
    const rendered = Array.isArray(v)
      ? v.map((x) => (x instanceof Html ? x.value : esc(x))).join('')
      : v instanceof Html
        ? v.value
        : esc(v);
    out += rendered + (strings[i + 1] ?? '');
  });
  return new Html(out);
}

const STYLE = `
:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fafafa; --muted: #6e6e73; --line: #d2d2d7; --accent: #0a66c2; --bad: #c62828; }
@media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --bg: #161617; --muted: #a1a1a6; --line: #3a3a3c; --accent: #4ea1ff; --bad: #ff6b6b; } }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
main { max-width: 860px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 22px; } h2 { font-size: 17px; margin-top: 32px; }
table { width: 100%; border-collapse: collapse; } td, th { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
.muted { color: var(--muted); } .bad { color: var(--bad); } .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
form.inline { display: inline; }
input, select, button { font: inherit; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; }
button { cursor: pointer; } button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
label { display: block; margin: 8px 0 2px; font-size: 13px; color: var(--muted); }
fieldset { border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin: 12px 0; }
code { font-size: 13px; }
`;

export function layout(title: string, body: Html, header?: Html): string {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${title} · inboxmux</title>
<style>${new Html(STYLE)}</style>
</head>
<body><main>${header ?? ''}${body}</main></body>
</html>`.value;
}
