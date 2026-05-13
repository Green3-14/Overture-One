// worker/index.js
// Mini-browser reverse proxy for Cloudflare Workers
// Route this Worker at: yourdomain.com/p/*
// Requires a KV namespace binding named "TAB_COOKIES_KV" (see wrangler.toml)

addEventListener('fetch', event => {
  event.respondWith(handle(event.request))
})

const PREFIX = '/p/'
const CACHE_TTL = 60 * 5
const MAX_CONTENT_LENGTH = 12 * 1024 * 1024

// PRIVATE ranges
const PRIVATE_RANGES = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^0\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i
]

// KV binding (configured in wrangler.toml)
const KV = typeof TAB_COOKIES_KV !== 'undefined' ? TAB_COOKIES_KV : null

// Base64url helpers
function b64urlEncode(s) {
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
}
function b64urlDecode(s) {
  s = s.replace(/-/g,'+').replace(/_/g,'/')
  while (s.length % 4) s += '='
  try { return atob(s) } catch(e) { return null }
}

function isPrivateHost(host) {
  if (!host) return true
  host = host.split(':')[0]
  for (const re of PRIVATE_RANGES) if (re.test(host)) return true
  if (!host.includes('.')) return true
  return false
}

function proxyPathFor(url) { return PREFIX + b64urlEncode(url) }
function resolveUrlSafe(href, base) {
  href = (href||'').trim()
  if (!href) return null
  if (/^(javascript|data|mailto|tel):/i.test(href)) return null
  if (href.startsWith('//')) {
    const baseProto = new URL(base).protocol
    return baseProto + href
  }
  try { return new URL(href, base).toString() } catch(e){ return null }
}

function rewriteCssUrls(cssText, base) {
  return cssText.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m,q,inside)=>{
    const resolved = resolveUrlSafe(inside, base)
    if (!resolved) return m
    return `url("${proxyPathFor(resolved)}")`
  })
}

function filterRequestHeaders(inHeaders) {
  const out = new Headers()
  for (const [k,v] of inHeaders) {
    const lk = k.toLowerCase()
    if (['host','cookie','authorization','proxy-authorization','x-forwarded-for','cf-connecting-ip'].includes(lk)) continue
    out.set(k,v)
  }
  out.set('user-agent', inHeaders.get('user-agent') || 'mini-browser/1.0')
  return out
}

async function buildOriginRequest(clientReq, targetUrl, tabId) {
  const method = clientReq.method
  const body = (method === 'GET' || method === 'HEAD') ? null : clientReq.body
  const headers = filterRequestHeaders(clientReq.headers)

  if (KV && tabId) {
    try {
      const key = `cookies:${tabId}:${new URL(targetUrl).origin}`
      const cookieString = await KV.get(key)
      if (cookieString) headers.set('cookie', cookieString)
    } catch(e){}
  } else {
    const clientCookies = clientReq.headers.get('x-proxy-client-cookies')
    if (clientCookies) headers.set('cookie', clientCookies)
  }

  return new Request(targetUrl, { method, headers, body, redirect:'manual' })
}

// HTMLRewriter handlers
class AttrRewriter {
  constructor(attr, base) { this.attr = attr; this.base = base }
  element(el) {
    const v = el.getAttribute(this.attr)
    if (!v) return
    const r = resolveUrlSafe(v, this.base)
    if (!r) return
    el.setAttribute(this.attr, proxyPathFor(r))
  }
}
class SrcsetRewriter {
  constructor(base){ this.base = base }
  element(el){
    const v = el.getAttribute('srcset'); if(!v) return
    const parts = v.split(',')
    const out = parts.map(p=>{
      const s = p.trim().split(/\s+/)
      const url = s[0]; const rest = s.slice(1).join(' ')
      const r = resolveUrlSafe(url, this.base)
      if (!r) return p
      return proxyPathFor(r) + (rest ? ' ' + rest : '')
    }).join(', ')
    el.setAttribute('srcset', out)
  }
}
class MetaRefreshRewriter {
  constructor(base){ this.base = base }
  element(el){
    const httpEq = el.getAttribute('http-equiv'); if(!httpEq) return
    if (httpEq.toLowerCase() !== 'refresh') return
    const content = el.getAttribute('content') || ''
    const m = content.match(/^\s*\d+\s*;\s*url=(.*)/i); if(!m) return
    let url = m[1].trim().replace(/^['"]|['"]$/g,'')
    const r = resolveUrlSafe(url, this.base)
    if(!r) return
    el.setAttribute('content', content.replace(url, proxyPathFor(r)))
  }
}
class StyleTagRewriter {
  constructor(base){ this.base = base }
  element(el){
    const txt = el.textContent || ''
    if (!txt) return
    el.setInnerContent(rewriteCssUrls(txt, this.base))
  }
}

function sanitizeResponseHeaders(h) {
  const out = new Headers()
  for (const [k,v] of h) {
    const lk = k.toLowerCase()
    if (['set-cookie','content-security-policy','x-frame-options','x-content-security-policy','x-webkit-csp'].includes(lk)) continue
    if (['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailers','transfer-encoding','upgrade'].includes(lk)) continue
    out.set(k,v)
  }
  out.set('access-control-allow-origin','*')
  out.set('x-proxy','mini-browser')
  return out
}

async function handle(request) {
  const url = new URL(request.url)
  if (!url.pathname.startsWith(PREFIX)) return fetch(request)

  const enc = url.pathname.slice(PREFIX.length)
  const decoded = b64urlDecode(enc + url.search)
  if (!decoded) return new Response('Invalid target', { status: 400 })
  let target
  try { target = new URL(decoded).toString() } catch(e){ return new Response('Bad URL', { status: 400 }) }
  if (!['http:','https:'].includes(new URL(target).protocol)) return new Response('Unsupported protocol', { status: 400 })
  if (isPrivateHost(new URL(target).hostname)) return new Response('Blocked target (private/local)', { status: 403 })

  // cache key
  const cacheKey = new Request(request.url)
  try {
    const cached = await caches.default.match(cacheKey)
    if (cached) return cached
  } catch(e){}

  const tabId = (new URL(request.url)).searchParams.get('tab') || null

  const originReq = await buildOriginRequest(request, target, tabId)
  let originRes
  try { originRes = await fetch(originReq) } catch(e){ return new Response('Upstream fetch failed', { status:502 }) }

  // handle Set-Cookie: persist to KV per tab+origin if available; also add x-proxy-set-cookie header for frontend
  const sc = originRes.headers.get('set-cookie')
  if (sc) {
    if (KV && tabId) {
      try {
        const key = `cookies:${tabId}:${new URL(target).origin}`
        // naive: overwrite; production: merge and manage expiry
        await KV.put(key, decodeURIComponent(encodeURIComponent(sc)))
      } catch(e){}
    }
  }

  // handle redirects
  if (originRes.status >= 300 && originRes.status < 400) {
    const loc = originRes.headers.get('location')
    if (loc) {
      const resolved = resolveUrlSafe(loc, target)
      if (resolved) {
        const headers = sanitizeResponseHeaders(originRes.headers)
        headers.set('location', proxyPathFor(resolved) + (tabId ? `?tab=${tabId}` : ''))
        if (sc) headers.set('x-proxy-set-cookie', encodeURIComponent(sc))
        const resp = new Response(null, { status: originRes.status, headers })
        try { await caches.default.put(cacheKey, resp.clone()) } catch(e){}
        return resp
      }
    }
  }

  const ct = originRes.headers.get('content-type') || ''
  const sanitized = sanitizeResponseHeaders(originRes.headers)
  if (sc) sanitized.set('x-proxy-set-cookie', encodeURIComponent(sc))

  if (ct.includes('text/html')) {
    const base = target
    const rewriter = new HTMLRewriter()
      .on('a', new AttrRewriter('href', base))
      .on('link', new AttrRewriter('href', base))
      .on('img', new AttrRewriter('src', base))
      .on('script', new AttrRewriter('src', base))
      .on('iframe', new AttrRewriter('src', base))
      .on('form', new AttrRewriter('action', base))
      .on('source', new AttrRewriter('src', base))
      .on('video', new AttrRewriter('src', base))
      .on('audio', new AttrRewriter('src', base))
      .on('img', new SrcsetRewriter(base))
      .on('source', new SrcsetRewriter(base))
      .on('meta', new MetaRefreshRewriter(base))
      .on('base', { element(el){ el.remove() } })
      .on('style', new StyleTagRewriter(base))
      .on('head', {
        element(el){
          el.append(`<script>
            // small helper shell for future iframe-parent messaging (left intentionally light)
          </script>`, { html:true })
        }
      })

    const transformed = rewriter.transform(originRes)
    const final = new Response(transformed.body, { status: originRes.status, headers: sanitized })
    try {
      const c = final.clone()
      c.headers.set('cache-control', 'public, max-age=' + CACHE_TTL)
      await caches.default.put(cacheKey, c)
    } catch(e){}
    return final
  } else if (ct.includes('text/css')) {
    const text = await originRes.text()
    const rewritten = rewriteCssUrls(text, target)
    sanitized.set('content-length', String(new TextEncoder().encode(rewritten).length))
    const resp = new Response(rewritten, { status: originRes.status, headers: sanitized })
    try { await caches.default.put(cacheKey, resp.clone()) } catch(e){}
    return resp
  } else {
    const cl = originRes.headers.get('content-length')
    if (cl && Number(cl) > MAX_CONTENT_LENGTH) return new Response('Resource too large', { status: 413 })
    const resp = new Response(originRes.body, { status: originRes.status, headers: sanitized })
    try { await caches.default.put(cacheKey, resp.clone()) } catch(e){}
    return resp
  }
}
