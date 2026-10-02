// HTML for the pages Caddy serves when there's nothing to forward to.
// `{http.request.host}` is a Caddy placeholder. Go's HTTP server rejects Host
// headers containing < > or ", so it is safe inside a text node.

const page = (title: string, body: string) =>
	`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
body { font: 16px/1.5 system-ui, sans-serif; max-width: 36rem; margin: 15vh auto; padding: 0 1.5rem; color: #222; background: #fafaf7; }
code { background: #eee; padding: 0.1em 0.3em; border-radius: 3px; }
@media (prefers-color-scheme: dark) { body { color: #ddd; background: #161616; } code { background: #2a2a2a; } }
</style>
</head>
<body>
${body}
</body>
</html>
`;

export const fallbackPage = (domain: string) =>
	page(
		"No porch here",
		`<h1>There is no porch at {http.request.host}</h1>
<p>Nothing on this machine is named that. Run <code>porch ls</code> to see the porches under ${domain}.</p>`,
	);

/**
 * Escapes text for HTML. Braces become entities too, because Caddy reads
 * `{...}` in a response body as a placeholder.
 */
export const esc = (text: string) =>
	text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("{", "&#123;")
		.replaceAll("}", "&#125;");

/**
 * What a dark porch says. The three parts are HTML fragments, already
 * escaped, or Caddy placeholders that expand to escaped text at request time.
 * `upstream` is what it forwards to. `light` says how to start it, when porch knows.
 */
export const darkPage = (name: string, upstream: string, light: string) =>
	page(
		`${name} is dark`,
		`<h1>${name} is dark</h1>
<p>This porch exists, but nothing answers at <code>${upstream}</code>.</p>
<p>${light}</p>`,
	);
