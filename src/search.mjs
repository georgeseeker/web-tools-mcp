// web_search: query Bing and parse the result list.
//
// No API key, no cookies, no login. Two decoders:
//
//   1. Bing's RSS endpoint (?format=rss) is the primary path. It has a stable
//      schema, returns real unwrapped URLs and includes <pubDate>. Nothing about
//      it depends on Bing's CSS class names, so a markup redesign cannot break it.
//   2. The HTML endpoint (li.b_algo) is the fallback, for the day RSS disappears.
//
// Both endpoints behave the same way and neither is documented:
//   * They return about 10 results per request regardless of `count`.
//   * `first` (the paging offset) is accepted but ignored, so there is no paging.
//     That is why this tool exposes no page parameter.
// The paid Bing Search API is a separate surface with its own documented limits.
//
// The other rule that matters: a *blocked* response must never be mistaken for
// "no results".

import { HttpError, decodeBytes, htmlToText, httpGet } from './http.mjs';

export const DEFAULT_COUNT = 8;
export const MAX_COUNT = 10; // Bing returns about this many per request

// Bing's own properties show up as anchors on every result page; they are noise.
const NOISE_URL = /(^|\.)(bing\.com|microsoft\.com|microsofttranslator\.com|msn\.com)$/i;

/**
 * Signals that the response is an anti-bot / consent / error page rather than a
 * result list. Only consulted when zero results were parsed, so a legitimate
 * page that happens to contain one of these words is unaffected.
 */
const BLOCK_SIGNALS = [
  ['captcha', 'a CAPTCHA challenge'],
  ['unusual traffic', 'an "unusual traffic" notice'],
  ['anomaly detected', 'an "anomaly detected" notice'],
  ['challenge-form', 'a challenge form'],
  ['verify you are a human', 'a human-verification prompt'],
  ['before you continue to bing', 'a cookie/consent interstitial'],
  ['accept all cookies', 'a cookie/consent interstitial'],
];

export function detectBlock(html, status) {
  if (status === 429) return 'HTTP 429 — Bing is rate limiting this IP.';
  if (status >= 500) return `HTTP ${status} from Bing (server-side error).`;
  const lower = String(html ?? '').toLowerCase();
  for (const [needle, label] of BLOCK_SIGNALS) {
    if (lower.includes(needle)) return `Bing returned ${label} (matched "${needle}").`;
  }
  return null;
}

/** True when Bing explicitly says the query has no results (not a block). */
export function looksLikeNoResults(body) {
  const lower = String(body ?? '').toLowerCase();
  return lower.includes('there are no results for') || lower.includes('no results found for');
}

/**
 * Turn a Bing result href into the real target URL.
 * With the HTML endpoint some results are wrapped in
 * https://www.bing.com/ck/a?...&u=a1<base64url>. Unwrap those; drop anything
 * that is not a plain http(s) URL we can hand back to the caller.
 */
export function normalizeResultUrl(href) {
  const raw = htmlToText(href);
  if (!raw) return null;
  if (/^https?:\/\/(www\.)?bing\.com\/ck\/a\?/i.test(raw)) {
    const m = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(raw);
    if (!m) return null;
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(m[1].length / 4) * 4, '=');
    try {
      const real = Buffer.from(b64, 'base64').toString('utf8');
      return /^https?:\/\//i.test(real) ? real : null;
    } catch {
      return null;
    }
  }
  if (!/^https?:\/\//i.test(raw)) return null;
  return raw;
}

function pushResult(list, seen, { title, url, snippet, published }) {
  const cleanTitle = htmlToText(title);
  if (!cleanTitle || cleanTitle.length < 2) return;
  const href = normalizeResultUrl(url);
  if (!href) return;
  try {
    if (NOISE_URL.test(new URL(href).hostname)) return;
  } catch {
    return;
  }
  const key = href.replace(/#.*$/, '');
  if (seen.has(key)) return;
  seen.add(key);
  const entry = { title: cleanTitle, url: href, snippet: htmlToText(snippet).slice(0, 300) };
  if (published) entry.published = String(published).trim();
  list.push(entry);
}

/** Primary decoder: Bing's RSS 2.0 output. */
export function parseBingRss(xml) {
  const list = [];
  const seen = new Set();
  // Split on <item> rather than counting <link>: a channel and an image also
  // carry <link> tags, so the counts do not line up.
  for (const item of String(xml ?? '').split(/<item>/i).slice(1)) {
    const title = /<title>([\s\S]*?)<\/title>/i.exec(item)?.[1];
    const link = /<link>([\s\S]*?)<\/link>/i.exec(item)?.[1];
    const description = /<description>([\s\S]*?)<\/description>/i.exec(item)?.[1];
    const pubDate = /<pubDate>([\s\S]*?)<\/pubDate>/i.exec(item)?.[1];
    pushResult(list, seen, { title, url: link, snippet: description, published: pubDate });
  }
  return { results: list, strategy: list.length > 0 ? 'rss' : 'rss-empty' };
}

/** Fallback decoder: the <li class="b_algo"> blocks of the HTML result page. */
function parseAlgoBlocks(html, list, seen) {
  // Split on the opening tag with a lookahead rather than matching to the first
  // </li>: b_algo blocks can contain nested <ul>/<li> sitelink lists.
  const blocks = String(html ?? '').split(/(?=<li[^>]*class="[^"]*\bb_algo\b)/i).slice(1);
  for (const block of blocks) {
    const anchor = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!anchor) continue;
    const snippet =
      /class="b_caption"[^>]*>[\s\S]{0,300}?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ??
      /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ??
      /<cite[^>]*>([\s\S]*?)<\/cite>/i.exec(block)?.[1];
    pushResult(list, seen, { title: anchor[2], url: anchor[1], snippet });
  }
}

/** Last resort: any external anchor with a plausible title. */
function parseGenericAnchors(html, list, seen) {
  const anchorRe = /<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(html)) !== null) {
    if (htmlToText(match[2]).length < 15) continue;
    pushResult(list, seen, { title: match[2], url: match[1], snippet: '' });
  }
}

/** Parse a Bing HTML result page. */
export function parseBingResults(html) {
  const list = [];
  const seen = new Set();
  parseAlgoBlocks(html, list, seen);
  if (list.length === 0) parseGenericAnchors(html, list, seen);
  return { results: list, strategy: list.length > 0 ? 'b_algo' : 'anchors' };
}

export function buildSearchUrl(query, { count = DEFAULT_COUNT, rss = false } = {}) {
  const url = new URL('https://www.bing.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));
  // Bing's zh-CN market backend mis-segments multi-word Chinese queries: "机器学习 入门"
  // comes back with dictionary entries for the single character 机器. ensearch=1 selects
  // the global backend, which segments correctly. The locale parameters (setlang, setmkt,
  // mkt, cc) have no effect on this.
  url.searchParams.set('ensearch', '1');
  if (rss) url.searchParams.set('format', 'rss');
  return url.href;
}

const clampCount = (n) => Math.min(MAX_COUNT, Math.max(1, Number.isFinite(n) ? Math.floor(n) : DEFAULT_COUNT));

/**
 * Run a search. Returns { results, strategy, note } or throws HttpError with a
 * code explaining exactly why it failed.
 */
export async function searchBing(query, options = {}) {
  const count = clampCount(options.count);
  const notes = [];

  // ---- Primary: RSS -------------------------------------------------------
  let rssError = null;
  try {
    const res = await httpGet(buildSearchUrl(query, { count, rss: true }), {
      timeoutMs: options.timeoutMs,
      throttleMs: 800,
    });
    if (res.status >= 200 && res.status < 400) {
      if (/consent\.bing\.com/i.test(new URL(res.finalUrl).hostname)) {
        throw new HttpError('SEARCH_CONSENT_WALL', 'Bing redirected to a consent page.');
      }
      const xml = decodeBytes(res.bytes, res.charset);
      const { results } = parseBingRss(xml);
      if (results.length > 0) {
        if (count > results.length) {
          notes.push(`Bing returns at most ${results.length} results per query; \`count\` above that has no effect.`);
        }
        return { results: results.slice(0, count), strategy: 'rss', note: notes.join(' ') || null };
      }
      rssError = detectBlock(xml, res.status);
    } else {
      rssError = detectBlock('', res.status);
    }
  } catch (err) {
    if (err instanceof HttpError && err.code === 'SEARCH_CONSENT_WALL') throw err;
    rssError = err instanceof Error ? err.message : String(err);
  }

  // ---- Fallback: HTML -----------------------------------------------------
  const res = await httpGet(buildSearchUrl(query, { count }), {
    timeoutMs: options.timeoutMs,
    throttleMs: 800,
  });

  if (res.status < 200 || res.status >= 400) {
    const block = detectBlock('', res.status);
    throw new HttpError('SEARCH_HTTP', block ?? `Bing returned HTTP ${res.status} ${res.statusText}.`, {
      status: res.status,
      url: res.finalUrl,
    });
  }

  const html = decodeBytes(res.bytes, res.charset);
  const { results, strategy } = parseBingResults(html);

  if (results.length === 0) {
    const block = detectBlock(html, res.status);
    if (block) {
      throw new HttpError('SEARCH_BLOCKED', `${block} This is not an empty result set.`, {
        url: res.finalUrl,
        status: res.status,
      });
    }
    if (looksLikeNoResults(html)) {
      return { results: [], strategy, note: 'Bing reports no results for this query.' };
    }
    throw new HttpError(
      'SEARCH_UNPARSEABLE',
      `Bing returned HTTP 200 but neither the RSS nor the HTML decoder found any results${rssError ? ` (RSS: ${rssError})` : ''}, ` +
        'and no anti-bot signal was present. Bing may have changed its output — the decoder needs updating.',
      { url: res.finalUrl, status: res.status },
    );
  }

  if (strategy !== 'b_algo') notes.push('parsed via the anchor fallback');
  if (rssError) notes.push(`RSS path failed (${rssError}); fell back to HTML`);
  return { results: results.slice(0, count), strategy, note: notes.join(' ') || null };
}

/** Human-readable rendering for the tool result. */
export function formatSearchResults(query, { results, strategy, note }, { count }) {
  const lines = [`Search: ${query}`, `Source: Bing (${strategy})  requested=${count}`];
  if (note) lines.push(`Note: ${note}`);
  lines.push('');
  if (results.length === 0) {
    lines.push('(no results)');
    return lines.join('\n');
  }
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    if (r.published) lines.push(`   published: ${r.published}`);
    lines.push('');
  });
  lines.push('Note: results are steered by this machine\'s network exit location; there is no paging.');
  return lines.join('\n').trimEnd();
}
