const express = require('express');
const cheerio = require('cheerio');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.raw({ type: '*/*', limit: '25mb' }));

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

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

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

async function handleProxy(targetUrl, req, res) {
  try {
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
  const referer = req.headers['referer'];
  if (referer) {
    try {
      const refUrl = new URL(referer);
      const proxiedTarget = refUrl.searchParams.get('url');
      if (proxiedTarget) {
        const baseTarget = new URL(proxiedTarget);
        const resolvedTarget = new URL(req.originalUrl, baseTarget.origin);
        return handleProxy(resolvedTarget, req, res);
      }
    } catch {}
  }
  return res.status(404).send('Not found');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
