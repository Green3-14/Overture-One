# Overture-One
Deployment notes

Create a Cloudflare Workers KV namespace (Dashboard → Workers → KV) and add it to wrangler.toml by replacing REPLACE_WITH_YOUR_KV_ID.
Deploy the Worker (wrangler publish from worker/ or paste index.js into Workers dashboard) and set route to yourdomain.com/p/*.
Deploy the pages/ directory to Cloudflare Pages (or any static host) at yourdomain.com so /index.html, /app.js, /style.css are served.
Ensure the Worker and Pages use same domain so iframe URLs remain simple and tab cookie KV keys map correctly.
Test with public sites. For debugging, watch Worker logs. Keep private-host blocking enabled unless you intentionally disable it.
Security & operational notes (brief)

KV cookie handling is best-effort and naive: it stores raw Set-Cookie strings per tab+origin and re-sends them on subsequent requests; for production you should parse, merge, and respect cookie attributes (path, expiry, Secure, HttpOnly) and avoid storing HttpOnly cookies client-accessible.
This proxy can be abused. Monitor rate, add abuse protections (rate-limits, request-size caps), and consider authentication for public deployment.
Some sites still may break (OAuth, WebSockets, advanced anti-frame checks). Durable Objects could provide stronger per-tab session management if desired.
If you want I can:

Provide a Durable Object version for per-tab state (cookies, storage) with sample code and wrangler config.
Produce a cleaned GitHub repo ZIP with files and a ready-to-run wrangler publish script.
Add a simple auth gate (basic token) to the Worker route.
