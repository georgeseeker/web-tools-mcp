// Extract readable Markdown from fetched pages with Readability and Turndown.

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

import { HttpError, decodeBytes, httpGet } from './http.mjs';

export const DEFAULT_MAX_LENGTH = 5000;

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
  ['a[href]', 'href'],
  ['img[src]', 'src'],
  ['source[src]', 'src'],
  ['video[poster]', 'poster'],
  ['video[src]', 'src'],
  ['audio[src]', 'src'],
];

/** Resolve relative URLs in the body fallback. */
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

/** Convert HTML to { markdown, title, via: 'readability' | 'body' }. */
export function htmlToMarkdown(html, url) {
  const dom = new JSDOM(html, { url });
  try {
    const { document } = dom.window;
    const title = document.title ? document.title.trim() : '';

    stripAll(document, HARD_STRIP);

    let content = null;
    let via = 'readability';
    let articleTitle = '';
    try {
      // Readability mutates its input document.
      const article = new Readability(document.cloneNode(true)).parse();
      if (article && typeof article.content === 'string' && article.content.trim().length > 0) {
        content = article.content;
        articleTitle = (article.title ?? '').trim();
      }
    } catch {
      content = null; // fall through to the body
    }

    if (content === null) {
      via = 'body';
      const body = document.body;
      if (!body) return { markdown: '', title, via };
      stripAll(body, SOFT_STRIP);
      absolutize(body, url);
      content = body.innerHTML;
    }

    return finish(content, articleTitle || title, via);
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

/** Slice text for start_index/max_length, reporting what is left. */
export function paginate(text, startIndex, maxLength) {
  const total = text.length;
  const start = Math.max(0, Math.min(Math.trunc(startIndex) || 0, total));
  const length = Math.max(1, Math.trunc(maxLength) || DEFAULT_MAX_LENGTH);
  const end = Math.min(start + length, total);
  return { slice: text.slice(start, end), start, end, total, hasMore: end < total, remaining: total - end };
}

/** Fetch and extract one page, with optional raw output and pagination. */
export async function fetchPage(rawUrl, options = {}) {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  const startIndex = options.startIndex ?? 0;
  const raw = options.raw === true;

  const res = await httpGet(rawUrl, { timeoutMs: options.timeoutMs, throttleMs: 800 });

  if (res.status >= 400) {
    throw new HttpError(
      'HTTP_STATUS',
      `HTTP ${res.status} ${res.statusText || ''}`.trim() + ` for ${res.finalUrl}`,
      { status: res.status, url: res.finalUrl },
    );
  }

  const kind = classifyContentType(res.contentType);
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
  if (raw || kind === 'text') {
    body = decoded;
    if (kind === 'html') {
      const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(decoded);
      title = m ? m[1].trim() : '';
    }
    if (kind === 'text') via = 'plain';
  } else {
    const converted = htmlToMarkdown(decoded, res.finalUrl);
    body = converted.markdown;
    title = converted.title;
    via = converted.via;
  }

  if (body.trim().length === 0) {
    throw new HttpError(
      'EMPTY_CONTENT',
      `Fetched ${res.finalUrl} (HTTP ${res.status}, ${res.contentType || 'no content-type'}) but ` +
        'extracted no text. The page is probably a JavaScript shell that needs a real browser — ' +
        'try the playwright browser tools instead.',
      { url: res.finalUrl, status: res.status },
    );
  }

  const page = paginate(body, startIndex, maxLength);
  return {
    finalUrl: res.finalUrl,
    status: res.status,
    contentType: res.contentType,
    charset: res.charset,
    title,
    via,
    downloadTruncated: res.truncated,
    page,
  };
}

/** Human-readable rendering for the tool result. */
export function formatFetchedPage(result) {
  const { page } = result;
  const header = [
    `URL: ${result.finalUrl}`,
    `Status: ${result.status}`,
    `Content-Type: ${result.contentType || '(none)'}  charset=${result.charset}`,
    result.title ? `Title: ${result.title}` : null,
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
