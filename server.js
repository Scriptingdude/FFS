const http = require('http');
const express = require('express');
const cheerio = require('cheerio');
const WebSocket = require('ws');
const { URL } = require('url');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 8080;

app.use(express.raw({ type: '*/*', limit: '25mb' }));

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>Web Viewer</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
    body, html { height: 100%; display: flex; flex-direction: column; background: #111; color: #fff; }
    .bar { display: flex; gap: 8px; padding: 10px 12px; background: #1e1e1e; border-bottom: 1px solid #333; align-items: center; }
    button { background: #2c2c2e; color: #fff; border: none; border-radius: 8px; padding: 10px 14px; font-size: 16px; cursor: pointer; }
    button:active { background: #444; }
    input { flex: 1; padding: 10px 14px; border-radius: 10px; border: 1px solid #3a3a3c; background: #2c2c2e; color: #fff; font-size: 16px; outline: none; }
    iframe { flex: 1; width: 100%; border: none; background: #fff; }
  </style>
</head>
<body>
  <form class="bar" onsubmit="go(event)">
    <button type="button" onclick="frame.contentWindow.history.back()">←</button>
    <button type="button" onclick="frame.contentWindow.history.forward()">→</button>
    <input id="url" type="text" placeholder="Enter URL (e.g. krillion.io)" autocapitalize="none" autocorrect="off" />
    <button type="submit">Go</button>
  </form>
  <iframe id="frame" name="frame"></iframe>
  <script>
    const frame = document.getElementById('frame');
    const input = document.getElementById('url');
    function go(e) {
      e.preventDefault();
      let val = input.value.trim();
      if (!val) return;
      if (!val.startsWith('http://') && !val.startsWith('https://')) val = 'https://' + val;
      document.cookie = '__proxy_origin=' + encodeURIComponent(new URL(val).origin) + '; path=/; SameSite=Lax';
      frame.src = '/browse?url=' + encodeURIComponent(val);
    }
  </script>
</body>
</html>`;

const cookieJar = new Map();

function getCookiesFor(origin) {
  const jar = cookieJar.get(origin);
  if (!jar) return '';
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

function storeCookiesFrom(origin, setCookieHeaders) {
  if (!setCookieHeaders || !setCookieHeaders.length) return;
  if (!cookieJar.has(origin)) cookieJar.set(origin, new Map());
  const jar = cookieJar.get(origin);
  for (const raw of setCookieHeaders) {
    const firstPair = raw.split(';').at(0);
    const eqIdx = firstPair.indexOf('=');
    if (eqIdx > 0) {
      const name = firstPair.slice(0, eqIdx).trim();
      const val = firstPair.slice(eqIdx + 1).trim();
      jar.set(name, val);
    }
  }
}

function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach((cookie) => {
    const idx = cookie.indexOf('=');
    if (idx > 0) {
      const key = cookie.slice(0, idx).trim();
      const val = cookie.slice(idx + 1).trim();
      list[key] = decodeURIComponent(val);
    }
  });
  return list;
}

function proxifyUrl(rawUrl, baseUrl) {
  if (
    !rawUrl ||
    rawUrl.startsWith('data:') ||
    rawUrl.startsWith('blob:') ||
    rawUrl.startsWith('javascript:') ||
    rawUrl.startsWith('#') ||
    rawUrl.startsWith('/browse?url=')
  ) {
    return rawUrl;
  }
  try {
    const absolute = new URL(rawUrl, baseUrl).href;
    return `/browse?url=${encodeURIComponent(absolute)}`;
  } catch {
    return rawUrl;
  }
}

app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(INDEX_HTML);
});

async function handleProxy(targetUrl, req, res) {
  try {
    res.setHeader(
      'Set-Cookie',
      `__proxy_origin=${encodeURIComponent(targetUrl.origin)}; Path=/; SameSite=Lax`
    );

    const headers = {
      'User-Agent': 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      'Accept': req.headers['accept'] || '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': targetUrl.origin,
      'Referer': targetUrl.href,
    };

    const savedCookies = getCookiesFor(targetUrl.origin);
    if (savedCookies) {
      headers['Cookie'] = savedCookies;
    }

    if (req.headers['content-type'] && req.method !== 'GET' && req.method !== 'HEAD') {
      headers['Content-Type'] = req.headers['content-type'];
    }

    const fetchOptions = {
      method: req.method,
      headers,
      redirect: 'manual',
    };

    if (req.method !== 'GET' && req.method !== 'HEAD' && Buffer.isBuffer(req.body) && req.body.length > 0) {
      fetchOptions.body = req.body;
    }

    const response = await fetch(targetUrl.href, fetchOptions);

    const rawSetCookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : new Array();
    storeCookiesFrom(targetUrl.origin, rawSetCookies);

    const redirectStatuses = new Array(301, 302, 303, 307, 308);
    if (redirectStatuses.includes(response.status)) {
      const location = response.headers.get('location');
      if (location) {
        return res.redirect(response.status, proxifyUrl(location, targetUrl.href));
      }
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('Content-Security-Policy-Report-Only');
    res.removeHeader('Cross-Origin-Opener-Policy');
    res.removeHeader('Cross-Origin-Embedder-Policy');
    res.removeHeader('Content-Disposition');
    if (contentType.includes('text/html')) {
      const html = await response.text();
      const $ = cheerio.load(html);

      $('meta[http-equiv="Content-Security-Policy"]').remove();
      $('meta[http-equiv="X-Frame-Options"]').remove();
      $('[integrity]').removeAttr('integrity');
      $('[crossorigin]').removeAttr('crossorigin');

      const interceptorScript = `
        <script>
          (function() {
            const BASE = ${JSON.stringify(targetUrl.href)};
            function wrap(u) {
              if (!u || typeof u !== 'string') return u;
              if (
                u.startsWith('/browse?url=') ||
                u.startsWith('data:') ||
                u.startsWith('blob:') ||
                u.startsWith('javascript:') ||
                u.startsWith('#')
              ) return u;
              try {
                return '/browse?url=' + encodeURIComponent(new URL(u, BASE).href);
              } catch(e) { return u; }
            }

            const OrigWebSocket = window.WebSocket;
            window.WebSocket = function(url, protocols) {
              try {
                const resolved = new URL(url, BASE);
                if (resolved.protocol === 'http:') resolved.protocol = 'ws:';
                if (resolved.protocol === 'https:') resolved.protocol = 'wss:';
                const proxyProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const tunneled = proxyProto + '//' + window.location.host + '/ws?url=' + encodeURIComponent(resolved.href);
                return protocols ? new OrigWebSocket(tunneled, protocols) : new OrigWebSocket(tunneled);
              } catch (e) {
                return protocols ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
              }
            };
            window.WebSocket.prototype = OrigWebSocket.prototype;
            window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
            window.WebSocket.OPEN = OrigWebSocket.OPEN;
            window.WebSocket.CLOSING = OrigWebSocket.CLOSING;
            window.WebSocket.CLOSED = OrigWebSocket.CLOSED;

            const origFetch = window.fetch;
            window.fetch = function(input, init) {
              if (typeof input === 'string') input = wrap(input);
              else if (input instanceof Request) input = new Request(wrap(input.url), input);
              return origFetch.call(this, input, init);
            };

            const origOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url, ...rest) {
              return origOpen.call(this, method, wrap(url), ...rest);
            };

            const origSetAttr = Element.prototype.setAttribute;
            Element.prototype.setAttribute = function(name, value) {
              const lower = String(name).toLowerCase();
              if ((lower === 'src' || lower === 'href' || lower === 'action') && typeof value === 'string') {
                value = wrap(value);
              }
              return origSetAttr.call(this, name, value);
            };

            const elementsToHook = new Array(
              HTMLScriptElement,
              HTMLImageElement,
              HTMLLinkElement,
              HTMLIFrameElement
            );
            elementsToHook.forEach((El) => {
              if (!El || !El.prototype) return;
              const prop = El === HTMLLinkElement ? 'href' : 'src';
              const desc = Object.getOwnPropertyDescriptor(El.prototype, prop);
              if (desc && desc.set) {
                Object.defineProperty(El.prototype, prop, {
                  get: desc.get,
                  set: function(val) { return desc.set.call(this, wrap(val)); }
                });
              }
            });

            const origPush = history.pushState;
            history.pushState = function(state, title, url) {
              if (url) return origPush.call(this, state, title, wrap(url));
              return origPush.apply(this, arguments);
            };
            const origReplace = history.replaceState;
            history.replaceState = function(state, title, url) {
              if (url) return origReplace.call(this, state, title, wrap(url));
              return origReplace.apply(this, arguments);
            };
          })();
        </script>
      `;
      $('head').prepend(interceptorScript);

      $('[href]').each((_, el) => $(el).attr('href', proxifyUrl($(el).attr('href'), targetUrl.href)));
      $('[src]').each((_, el) => $(el).attr('src', proxifyUrl($(el).attr('src'), targetUrl.href)));
      $('form[action]').each((_, el) => $(el).attr('action', proxifyUrl($(el).attr('action'), targetUrl.href)));

      $('[srcset]').each((_, el) => {
        const srcset = $(el).attr('srcset');
        if (srcset) {
          const rewritten = srcset.split(',').map(part => {
            const trimmed = part.trim();
            const parts = trimmed.split(/\s+/);
            const urlPart = parts.at(0);
            const descriptor = parts.at(1);
            return descriptor ? `${proxifyUrl(urlPart, targetUrl.href)} ${descriptor}` : proxifyUrl(urlPart, targetUrl.href);
          }).join(', ');
          $(el).attr('srcset', rewritten);
        }
      });

      $('script:not([src])').each((_, el) => {
        let code = $(el).html();
        if (code) {
          code = code.replace(/(["'`])(\/(?:_app|_next|assets|static|api|build|chunks)\/[^"'`\s\\]+)\1/g, (m, q, p) => {
            return `${q}${proxifyUrl(p, targetUrl.href)}${q}`;
          });
          $(el).html(code);
        }
      });

      return res.status(response.status).send($.html());
    }
    if (contentType.includes('text/css')) {
      let css = await response.text();
      css = css.replace(/url\((['"]?)(.*?)\1\)/g, (match, quote, assetUrl) => {
        return `url(${quote}${proxifyUrl(assetUrl, targetUrl.href)}${quote})`;
      });
      css = css.replace(/@import\s+(['"])(.*?)\1/g, (match, quote, importUrl) => {
        return `@import ${quote}${proxifyUrl(importUrl, targetUrl.href)}${quote}`;
      });
      return res.status(response.status).send(css);
    }

    if (contentType.includes('javascript') || contentType.includes('ecmascript')) {
      let js = await response.text();
      js = js.replace(/(["'`])(\/(?:_app|_next|assets|static|api|build|chunks)\/[^"'`\s\\]+)\1/g, (match, quote, relPath) => {
        return `${quote}${proxifyUrl(relPath, targetUrl.href)}${quote}`;
      });
      js = js.replace(/((?:from|import)\s*\(?\s*["'`])(\.\.?\/[^"'`\s\\]+)(["'`])/g, (match, prefix, relModule, quote) => {
        return `${prefix}${proxifyUrl(relModule, targetUrl.href)}${quote}`;
      });
      return res.status(response.status).send(js);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return res.status(response.status).send(buffer);
  } catch (err) {
    return res.status(502).send(`Proxy error: ${err.message}`);
  }
}

app.all('/browse', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.redirect('/');
  try {
    const targetUrl = new URL(target.startsWith('http') ? target : `https://${target}`);
    return handleProxy(targetUrl, req, res);
  } catch {
    return res.status(400).send('Invalid URL');
  }
});

app.use(async (req, res) => {
  if (req.path === '/favicon.ico') {
    return res.status(204).end();
  }

  let baseOrigin = null;
  const referer = req.headers['referer'];
  if (referer) {
    try {
      const refUrl = new URL(referer);
      const proxiedTarget = refUrl.searchParams.get('url');
      if (proxiedTarget) {
        baseOrigin = new URL(proxiedTarget).origin;
      }
    } catch {}
  }

  if (!baseOrigin) {
    const cookies = parseCookies(req.headers['cookie']);
    if (cookies.__proxy_origin) {
      baseOrigin = cookies.__proxy_origin;
    }
  }

  if (baseOrigin) {
    try {
      const resolvedTarget = new URL(req.originalUrl, baseOrigin);
      return handleProxy(resolvedTarget, req, res);
    } catch {}
  }

  return res.status(404).send(`Not found: ${req.originalUrl}`);
});

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    if (reqUrl.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const targetWsParam = reqUrl.searchParams.get('url');
    if (!targetWsParam) {
      socket.destroy();
      return;
    }

    const targetWsUrl = new URL(targetWsParam);
    const savedCookies = getCookiesFor(targetWsUrl.origin.replace(/^ws/, 'http'));
    const wsHeaders = {
      'Origin': targetWsUrl.origin.replace(/^ws/, 'http'),
      'User-Agent': 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    };
    if (savedCookies) {
      wsHeaders['Cookie'] = savedCookies;
    }

    const protocols = req.headers['sec-websocket-protocol']
      ? req.headers['sec-websocket-protocol'].split(',').map(p => p.trim())
      : undefined;

    wss.handleUpgrade(req, socket, head, (clientWs) => {
      const remoteWs = protocols
        ? new WebSocket(targetWsUrl.href, protocols, { headers: wsHeaders })
        : new WebSocket(targetWsUrl.href, { headers: wsHeaders });

      const pendingMessages = new Array();

      remoteWs.on('open', () => {
        while (pendingMessages.length > 0) {
          const msg = pendingMessages.shift();
          remoteWs.send(msg.data, { binary: msg.isBinary });
        }
      });

      clientWs.on('message', (data, isBinary) => {
        if (remoteWs.readyState === WebSocket.OPEN) {
          remoteWs.send(data, { binary: isBinary });
        } else if (remoteWs.readyState === WebSocket.CONNECTING) {
          pendingMessages.push({ data, isBinary });
        }
      });

      remoteWs.on('message', (data, isBinary) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data, { binary: isBinary });
        }
      });

      clientWs.on('close', () => {
        if (remoteWs.readyState === WebSocket.OPEN || remoteWs.readyState === WebSocket.CONNECTING) {
          remoteWs.close();
        }
      });

      remoteWs.on('close', () => {
        if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) {
          clientWs.close();
        }
      });

      clientWs.on('error', () => remoteWs.terminate());
      remoteWs.on('error', () => clientWs.terminate());
    });
  } catch {
    socket.destroy();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`HTTP + WebSocket proxy running on port ${PORT}`);
});
