const express = require('express');
const cheerio = require('cheerio');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 8080;

// Parse form submissions & JSON bodies for two-way communication
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.raw({ type: '*/*', limit: '10mb' }));

// Serve the iPad touch-friendly UI
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// Helper to wrap target URLs through our proxy endpoint
function proxifyUrl(rawUrl, baseUrl) {
  if (!rawUrl || rawUrl.startsWith('data:') || rawUrl.startsWith('javascript:') || rawUrl.startsWith('#')) {
    return rawUrl;
  }
  try {
    const absolute = new URL(rawUrl, baseUrl).href;
    return `/browse?url=${encodeURIComponent(absolute)}`;
  } catch {
    return rawUrl;
  }
}

// Main proxy route handling GET, POST, PUT, DELETE
app.all('/browse', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.redirect('/');

  let targetUrl;
  try {
    targetUrl = new URL(target.startsWith('http') ? target : `https://${target}`);
  } catch {
    return res.status(400).send('Invalid URL');
  }

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      'Accept': req.headers['accept'] || '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': targetUrl.origin + '/',
    };

    if (req.headers['content-type'] && req.method !== 'GET' && req.method !== 'HEAD') {
      headers['Content-Type'] = req.headers['content-type'];
    }

    const fetchOptions = {
      method: req.method,
      headers,
      redirect: 'manual',
    };

    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      if (Buffer.isBuffer(req.body)) {
        fetchOptions.body = req.body;
      } else if (typeof req.body === 'object') {
        fetchOptions.body = new URLSearchParams(req.body).toString();
      }
    }

    const response = await fetch(targetUrl.href, fetchOptions);

    // Handle HTTP redirects cleanly so Safari stays inside the proxy
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (location) {
        return res.redirect(proxifyUrl(location, targetUrl.href));
      }
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';

    // Strip headers that block iframes or force downloads
    res.setHeader('Content-Type', contentType);
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('Content-Disposition');

    // Rewrite HTML pages
    if (contentType.includes('text/html')) {
      const html = await response.text();
      const $ = cheerio.load(html);

      // Inject client-side interceptor for dynamic fetch(), XHR, and window.open()
      const interceptorScript = `
        <script>
          (function() {
            const BASE = ${JSON.stringify(targetUrl.href)};
            function wrap(u) {
              if (!u || typeof u !== 'string') return u;
              if (u.startsWith('/browse?url=') || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('javascript:')) return u;
              try {
                return '/browse?url=' + encodeURIComponent(new URL(u, BASE).href);
              } catch(e) { return u; }
            }
            const origFetch = window.fetch;
            window.fetch = function(input, init) {
              if (typeof input === 'string') input = wrap(input);
              else if (input && input.url) input = new Request(wrap(input.url), input);
              return origFetch.call(this, input, init);
            };
            const origOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url, ...rest) {
              return origOpen.call(this, method, wrap(url), ...rest);
            };
            window.open = function(url) {
              if (url) window.location.href = wrap(url);
            };
          })();
        </script>
      `;
      $('head').prepend(interceptorScript);

      // Rewrite static HTML attributes
      $('[href]').each((_, el) => $(el).attr('href', proxifyUrl($(el).attr('href'), targetUrl.href)));
      $('[src]').each((_, el) => $(el).attr('src', proxifyUrl($(el).attr('src'), targetUrl.href)));
      $('form[action]').each((_, el) => $(el).attr('action', proxifyUrl($(el).attr('action'), targetUrl.href)));

      return res.send($.html());
    }

    // Rewrite CSS url(...) references
    if (contentType.includes('text/css')) {
      let css = await response.text();
      css = css.replace(/url\((['"]?)(.*?)\1\)/g, (match, quote, assetUrl) => {
        return `url(${quote}${proxifyUrl(assetUrl, targetUrl.href)}${quote})`;
      });
      return res.send(css);
    }

    // Stream images, fonts, and JS files directly
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    res.status(502).send(`Proxy error: ${err.message}`);
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
