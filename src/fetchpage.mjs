// Extract readable Markdown from fetched pages with Readability and Turndown.

import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

import { HttpError, decodeBytes, htmlToText, httpGet } from './http.mjs';

export const DEFAULT_MAX_LENGTH = 5000;

// --- extraction tuning -----------------------------------------------------

// Readability output shorter than this is suspicious (login walls, paywalls,
// comment fragments); fall back to the body when the body is much larger.
const MIN_ARTICLE_CHARS = 200;
const BODY_FALLBACK_RATIO = 0.1;

// --- page cache ------------------------------------------------------------
// Paginating a long article re-downloads and re-parses the whole page for
// every start_index otherwise. Keep extracted text for a short while.

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 24;
const CACHE_MAX_CHARS = 4_000_000;
const CACHE_MAX_BODY = 1_000_000;

const pageCache = new Map(); // key -> { at, value }

// --- transient-failure retry ----------------------------------------------

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 400;
const RETRYABLE_CODES = new Set(['TIMEOUT', 'CONNECT_TIMEOUT', 'CONNECTION_FAILED']);
const RETRYABLE_STATUS = new Set([502, 503, 504]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Pages often carry stylesheets jsdom cannot parse; that is harmless noise.
const quietConsole = new VirtualConsole();

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  hr: '---',
});
turndown.use(gfm);
turndown.addRule('dropImages', { filter: 'img', replacement: () => '' });
turndown.addRule('emptyLinks', {
  filter: (node) => node.nodeName === 'A' && !node.getAttribute('href'),
  replacement: (content) => content,
});

// Remove scripts, styles and interactive markup from Markdown output.
turndown.remove([
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'object',
  'embed',
  'svg',
  'canvas',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'link',
  'meta',
  'head',
]);

export function classifyContentType(contentType) {
  const ct = String(contentType ?? '').toLowerCase().split(';')[0].trim();
  if (ct === 'text/html' || ct === 'application/xhtml+xml' || ct === '') return 'html';
  if (
    ct.startsWith('text/') ||
    ct === 'application/json' ||
    ct.endsWith('+json') ||
    ct === 'application/xml' ||
    ct.endsWith('+xml') ||
    ct === 'application/javascript' ||
    ct.endsWith('+yaml') ||
    ct === 'application/yaml'
  ) {
    return 'text';
  }
  return 'binary';
}

const HARD_STRIP =
  'script,style,noscript,template,svg,canvas,iframe,object,embed,form,input,button,select,textarea,link,meta';
// Remove page navigation when falling back to the full body.
const SOFT_STRIP = 'nav,header,footer,aside,[role="navigation"],[aria-hidden="true"]';

function stripAll(root, selector) {
  try {
    root.querySelectorAll(selector).forEach((node) => node.remove());
  } catch {
    /* malformed DOM — carry on with whatever we have */
  }
}

const ABSOLUTE_ATTRS = [
  // Images are dropped from the Markdown, so only links need resolving.
  ['a[href]', 'href'],
];

/**
 * Drop script/style blocks before jsdom parses them. They are never rendered
 * and removing them first cuts parse time on large pages noticeably.
 */
function precleanHtml(html) {
  // Only comments: stripping <script> blocks with a regex can truncate a
  // block early when the script itself contains "</script>".
  return String(html ?? '').replace(/<!--[\s\S]*?-->/g, '');
}

/** Resolve relative URLs in a subtree. */
export function absolutize(root, baseUrl) {
  for (const [selector, attr] of ABSOLUTE_ATTRS) {
    let nodes;
    try {
      nodes = root.querySelectorAll(selector);
    } catch {
      continue;
    }
    nodes.forEach((node) => {
      const raw = node.getAttribute(attr);
      if (!raw || /^(data:|mailto:|tel:|javascript:|#)/i.test(raw)) return;
      try {
        node.setAttribute(attr, new URL(raw, baseUrl).href);
      } catch {
        /* leave it alone */
      }
    });
  }
}

const cleanMeta = (value, limit = 300) =>
  String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);

function metaContent(document, selectors) {
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    const value = element?.getAttribute('content');
    if (value && value.trim()) return cleanMeta(value);
  }
  return '';
}

/** Page metadata from the document itself (Readability may refine it). */
function readMeta(document) {
  return {
    byline: metaContent(document, ['meta[name="author"]', 'meta[property="article:author"]']),
    siteName: metaContent(document, ['meta[property="og:site_name"]', 'meta[name="application-name"]']),
    publishedTime: metaContent(document, [
      'meta[property="article:published_time"]',
      'meta[name="date"]',
      'meta[name="pubdate"]',
      'meta[itemprop="datePublished"]',
    ]),
    lang: cleanMeta(document.documentElement?.getAttribute('lang'), 40),
    excerpt: metaContent(document, ['meta[name="description"]', 'meta[property="og:description"]']),
  };
}

const textLength = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().length;

/** Convert HTML to { markdown, title, via, meta }. */
export function htmlToMarkdown(html, url) {
  const cleaned = precleanHtml(html);
  const dom = new JSDOM(cleaned, { url, virtualConsole: quietConsole });
  try {
    const { document } = dom.window;
    const baseUrl = document.baseURI || url;
    const title = document.title ? document.title.trim() : '';
    const meta = readMeta(document);

    stripAll(document, HARD_STRIP);

    let content = null;
    let via = 'readability';
    let articleTitle = '';

    let article = null;
    try {
      // Readability mutates the document, so the body is re-parsed below if
      // its output turns out to be unusable.
      article = new Readability(document).parse();
    } catch {
      article = null;
    }

    if (article && typeof article.content === 'string' && article.content.trim()) {
      const articleChars = textLength(article.textContent ?? htmlToText(article.content));
      const bodyChars = textLength(document.body?.textContent ?? '');
      // Accept the article unless it is a fragment of a much larger page.
      const usable =
        articleChars >= MIN_ARTICLE_CHARS ||
        bodyChars === 0 ||
        articleChars >= bodyChars * BODY_FALLBACK_RATIO;

      if (usable) {
        content = article.content;
        articleTitle = (article.title ?? '').trim();
        meta.byline = cleanMeta(article.byline) || meta.byline;
        meta.siteName = cleanMeta(article.siteName) || meta.siteName;
        meta.publishedTime = cleanMeta(article.publishedTime) || meta.publishedTime;
        meta.lang = cleanMeta(article.lang, 40) || meta.lang;
        meta.excerpt = cleanMeta(article.excerpt, 500) || meta.excerpt;
      }
    }

    if (content === null) {
      via = 'body';
      // Readability mutated the first document; parse a fresh copy for the
      // fallback (rare path, so the extra parse is acceptable).
      const fallback = new JSDOM(cleaned, { url, virtualConsole: quietConsole });
      try {
        const body = fallback.window.document.body;
        if (!body) return { markdown: '', title, via, meta };
        stripAll(body, SOFT_STRIP);
        absolutize(body, baseUrl);
        content = body.innerHTML;
      } finally {
        try {
          fallback.window.close();
        } catch {
          /* already closed */
        }
      }
    } else {
      // Readability hands back HTML with whatever URLs the page used; resolve
      // them against the document base so Markdown links are usable.
      const holder = document.createElement('div');
      holder.innerHTML = content;
      absolutize(holder, baseUrl);
      content = holder.innerHTML;
    }

    const finished = finish(content, articleTitle || title, via);
    return { ...finished, meta };
  } finally {
    // Release jsdom timers and listeners.
    try {
      dom.window.close();
    } catch {
      /* already closed */
    }
  }
}

function finish(content, title, via) {
  let markdown = '';
  try {
    markdown = turndown.turndown(content);
  } catch {
    markdown = '';
  }
  return { markdown: markdown.replace(/\n{3,}/g, '\n\n').trim(), title, via };
}

// --- access-wall detection -------------------------------------------------

const LOGIN_URL =
  /\/(?:login|log-in|signin|sign-in|sign_in|auth|authenticate|account\/login|users\/sign_in)(?:[/?#]|$)/i;
const LOGIN_TITLE =
  /^(?:sign in|log in|login|sign up|subscribe|create (?:an |your )?account|are you a robot)/i;
const BLOCK_TITLE = /^(?:access denied|just a moment|attention required|403 forbidden|request blocked)/i;
const LOGIN_PHRASES = [
  'sign in to continue',
  'log in to continue',
  'sign in to read',
  'log in to read',
  'sign in to view',
  'log in to view',
  'subscribe to continue',
  'subscribe to read',
  'subscribe to keep reading',
  'subscribe for full access',
  'create a free account',
  'create an account to continue',
  'you must be logged in',
  'please log in',
  'please sign in',
  'enable javascript and cookies to continue',
  'verify you are human',
  'checking your browser',
  'unusual traffic from your computer',
];
const CHALLENGE_MARKERS = [
  'cf-browser-verification',
  'cf_chl_opt',
  'challenge-platform',
  'just a moment...',
  'attention required! | cloudflare',
];

function looksLikeChallenge(html) {
  const head = String(html ?? '').slice(0, 200_000).toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => head.includes(marker));
}

/** 'LOGIN_REQUIRED' / 'BLOCKED' when a 200 response is an interstitial. */
function detectAccessWall({ finalUrl, title, text }) {
  const body = String(text ?? '');
  if (body.length >= 3000) return null;

  const lower = body.toLowerCase();
  const heading = String(title ?? '').trim();
  let path = '';
  try {
    path = new URL(finalUrl).pathname;
  } catch {
    /* keep empty */
  }

  if (BLOCK_TITLE.test(heading) || looksLikeChallenge(body)) return 'BLOCKED';

  const onLoginPath = LOGIN_URL.test(path);
  const loginTitle = LOGIN_TITLE.test(heading);
  const phrase = LOGIN_PHRASES.some((needle) => lower.includes(needle));

  if (onLoginPath && (phrase || /password/i.test(body))) return 'LOGIN_REQUIRED';
  if (loginTitle && (phrase || onLoginPath || body.length < 800)) return 'LOGIN_REQUIRED';
  if (phrase && body.length < 1200) return 'LOGIN_REQUIRED';
  return null;
}

// --- pagination ------------------------------------------------------------

/** Don't end a chunk in the middle of a surrogate pair. */
function avoidSplitPair(text, end) {
  if (end <= 0 || end >= text.length) return end;
  const code = text.charCodeAt(end - 1);
  return code >= 0xd800 && code <= 0xdbff ? end - 1 : end;
}

/** Prefer ending a chunk at a paragraph break, if one is reasonably close. */
function snapToParagraph(text, start, end) {
  const earliest = start + Math.max(1, Math.floor((end - start) * 0.6));
  const index = text.lastIndexOf('\n\n', end - 1);
  return index >= earliest ? index + 2 : end;
}

/** Slice text for start_index/max_length, reporting what is left. */
export function paginate(text, startIndex, maxLength) {
  const total = text.length;
  const start = Math.max(0, Math.min(Math.trunc(Number(startIndex)) || 0, total));
  const length = Math.max(1, Math.trunc(Number(maxLength)) || DEFAULT_MAX_LENGTH);
  const hardEnd = Math.min(start + length, total);

  let end = hardEnd;
  if (hardEnd < total) {
    // Snapping may only end the chunk earlier; never let it exceed the limit.
    const snapped = avoidSplitPair(text, snapToParagraph(text, start, hardEnd));
    if (snapped > start) end = Math.min(snapped, hardEnd);
  }

  return { slice: text.slice(start, end), start, end, total, hasMore: end < total, remaining: total - end };
}

// --- cache -----------------------------------------------------------------

function cacheKey(rawUrl, raw) {
  let normalized = String(rawUrl ?? '').trim();
  try {
    normalized = new URL(normalized).href;
  } catch {
    /* keep the original string */
  }
  return `${raw ? 'raw' : 'md'}:${normalized}`;
}

function cacheGet(key) {
  const entry = pageCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    pageCache.delete(key);
    return null;
  }
  // Refresh insertion order so eviction removes the least recently used.
  pageCache.delete(key);
  pageCache.set(key, entry);
  return entry.value;
}

function cacheSet(key, value) {
  if (value.body.length > CACHE_MAX_BODY) return;
  pageCache.delete(key);
  pageCache.set(key, { at: Date.now(), value });

  let chars = 0;
  for (const entry of pageCache.values()) chars += entry.value.body.length;
  while (pageCache.size > CACHE_MAX_ENTRIES || chars > CACHE_MAX_CHARS) {
    const oldestKey = pageCache.keys().next().value;
    const oldest = pageCache.get(oldestKey);
    pageCache.delete(oldestKey);
    chars -= oldest.value.body.length;
  }
}

// --- fetching --------------------------------------------------------------

async function httpGetWithRetry(url, options) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await httpGet(url, options);
      if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_BASE_MS * attempt);
        continue;
      }
      return response;
    } catch (error) {
      const retryable = error instanceof HttpError && RETRYABLE_CODES.has(error.code);
      if (!retryable || attempt >= MAX_ATTEMPTS) throw error;
      await sleep(RETRY_BASE_MS * attempt);
    }
  }
}

async function fetchPageFull(rawUrl, options = {}) {
  const key = cacheKey(rawUrl, options.raw === true);
  const cached = cacheGet(key);
  if (cached) return cached;

  const res = await httpGetWithRetry(rawUrl, { timeoutMs: options.timeoutMs, throttleMs: 800 });
  const kind = classifyContentType(res.contentType);

  if (res.status >= 400) {
    // A 403/503 that carries a bot-challenge page is not a normal HTTP error.
    if (kind === 'html' && looksLikeChallenge(decodeBytes(res.bytes, res.charset))) {
      throw new HttpError(
        'BLOCKED',
        `${res.finalUrl} returned HTTP ${res.status} with a bot-protection challenge. ` +
          'web_fetch is anonymous and does not run JavaScript, so it cannot pass this. ' +
          'Use the playwright browser tools instead.',
        { status: res.status, url: res.finalUrl },
      );
    }
    const hint =
      res.status === 401 || res.status === 403
        ? ' The site refused an anonymous request (login, paywall, or bot filtering); try the playwright browser tools.'
        : res.status === 429
          ? ' The site is rate limiting requests; wait before retrying.'
          : '';
    throw new HttpError(
      'HTTP_STATUS',
      `HTTP ${res.status} ${res.statusText || ''}`.trim() + ` for ${res.finalUrl}.${hint}`,
      { status: res.status, url: res.finalUrl },
    );
  }

  if (kind === 'binary') {
    throw new HttpError(
      'UNSUPPORTED_CONTENT',
      `Unsupported content type "${res.contentType || '(none)'}" ` +
        `(${res.bytes.length} bytes). Only HTML, text, JSON and XML can be returned as text.`,
      { contentType: res.contentType, url: res.finalUrl },
    );
  }

  const decoded = decodeBytes(res.bytes, res.charset);

  let body;
  let title = '';
  let via = 'raw';
  let meta = {};
  if (options.raw || kind === 'text') {
    body = decoded;
    if (kind === 'html') {
      const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(decoded);
      title = match ? htmlToText(match[1]) : '';
    }
    if (kind === 'text') via = 'plain';
  } else {
    const converted = htmlToMarkdown(decoded, res.finalUrl);
    body = converted.markdown;
    title = converted.title;
    via = converted.via;
    meta = converted.meta ?? {};
  }

  if (body.trim().length === 0) {
    throw new HttpError(
      'EMPTY_CONTENT',
      `Fetched ${res.finalUrl} (HTTP ${res.status}, ${res.contentType || 'no content-type'}) but ` +
        `extracted no text${title ? ` (title: "${title}")` : ''}. The page is probably a JavaScript ` +
        'shell that needs a real browser — try the playwright browser tools instead.',
      { url: res.finalUrl, status: res.status },
    );
  }

  if (kind === 'html' && !options.raw) {
    const wall = detectAccessWall({ finalUrl: res.finalUrl, title, text: body });
    if (wall === 'BLOCKED') {
      throw new HttpError(
        'BLOCKED',
        `${res.finalUrl} served a bot-protection challenge instead of the page. ` +
          'web_fetch is anonymous and does not run JavaScript, so it cannot pass this. ' +
          'Use the playwright browser tools instead.',
        { status: res.status, url: res.finalUrl },
      );
    }
    if (wall === 'LOGIN_REQUIRED') {
      throw new HttpError(
        'LOGIN_REQUIRED',
        `${res.finalUrl} served a login, paywall, or account interstitial instead of the article ` +
          `(title: "${title || '(none)'}"). web_fetch has no cookies or session, so it cannot read ` +
          'this page. Use the playwright browser tools with your logged-in profile instead.',
        { status: res.status, url: res.finalUrl },
      );
    }
  }

  const result = {
    finalUrl: res.finalUrl,
    status: res.status,
    contentType: res.contentType,
    charset: res.charset,
    title,
    via,
    meta,
    downloadTruncated: res.truncated,
    body,
  };
  cacheSet(key, result);
  return result;
}

/** Fetch and extract one page, with optional raw output and pagination. */
export async function fetchPage(rawUrl, options = {}) {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  const startIndex = options.startIndex ?? 0;
  const raw = options.raw === true;

  const full = await fetchPageFull(rawUrl, { ...options, raw });
  const page = paginate(full.body, startIndex, maxLength);
  const { body, ...rest } = full;
  return { ...rest, page };
}

/** Human-readable rendering for the tool result. */
export function formatFetchedPage(result) {
  const { page, meta = {} } = result;
  const header = [
    `URL: ${result.finalUrl}`,
    `Status: ${result.status}`,
    `Content-Type: ${result.contentType || '(none)'}  charset=${result.charset}`,
    result.title ? `Title: ${result.title}` : null,
    meta.siteName ? `Site: ${meta.siteName}` : null,
    meta.byline ? `Byline: ${meta.byline}` : null,
    meta.publishedTime ? `Published: ${meta.publishedTime}` : null,
    meta.lang ? `Language: ${meta.lang}` : null,
    `Extracted via: ${result.via}`,
    `Total chars: ${page.total}  showing [${page.start}, ${page.end})`,
    result.downloadTruncated
      ? 'Note: the download hit the size cap, so the tail of the response was not read.'
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  let footer = '';
  if (page.hasMore) {
    footer =
      `\n\n--- truncated: ${page.remaining} characters remain. ` +
      `Call web_fetch again with start_index=${page.end} to continue. ---`;
  } else if (page.total > 0 && page.start >= page.total) {
    footer = `\n\n--- No more content available. This page is ${page.total} characters long. ---`;
  }

  return `${header}\n\n${page.slice}${footer}`;
}
