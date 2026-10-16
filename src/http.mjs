// HTTP requests with redirects, size limits, charset decoding and throttling.

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_BYTES = 10 * 1024 * 1024; // 10 MB download cap
export const MAX_REDIRECTS = 5;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

export class HttpError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    Object.assign(this, detail);
  }
}

export function isAllowedScheme(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

export function parseUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    throw new HttpError('BAD_URL', 'url must be a non-empty string.');
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new HttpError('BAD_URL', `Not a valid absolute URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpError(
      'BAD_SCHEME',
      `Only http: and https: URLs are supported (got "${parsed.protocol}"). ` +
        'file:, data:, ftp: and friends are refused on purpose.',
    );
  }
  return parsed;
}

// Private addresses require WEB_TOOLS_ALLOW_PRIVATE=1.

const ALLOW_PRIVATE = process.env.WEB_TOOLS_ALLOW_PRIVATE === '1';

export function isPrivateHost(hostname) {
  const host = String(hostname ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;

  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // fe80::/10 link-local
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
    return mapped ? isPrivateHost(mapped[1]) : false;
  }

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (m.slice(1).some((part) => Number(part) > 255)) return false;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, includes cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

// Serialize request starts with a minimum interval.

let throttleChain = Promise.resolve();
let lastRequestAt = 0;

export function throttle(minIntervalMs = 800) {
  const run = async () => {
    const wait = lastRequestAt + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
  };
  // Continue the queue after either success or failure.
  const next = throttleChain.then(run, run);
  throttleChain = next.then(
    () => {},
    () => {},
  );
  return next;
}

const CHARSET_ALIASES = new Map([
  ['gb2312', 'gbk'], // WHATWG maps gb2312 onto the GBK decoder
  ['gb_2312', 'gbk'],
  ['x-gbk', 'gbk'],
  ['utf8', 'utf-8'],
  ['latin1', 'windows-1252'],
  ['iso8859-1', 'windows-1252'],
  ['ascii', 'utf-8'],
]);

function normaliseCharset(label) {
  if (!label) return null;
  const key = String(label).trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (!key) return null;
  return CHARSET_ALIASES.get(key) ?? key;
}

/** charset= from a Content-Type header, or null. */
export function charsetFromContentType(contentType) {
  if (!contentType) return null;
  const m = /charset\s*=\s*("?)([^";,\s]+)\1/i.exec(contentType);
  return m ? normaliseCharset(m[2]) : null;
}

/** Detect meta charset using a byte-preserving latin1 view. */
export function charsetFromMeta(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const meta = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i.exec(head);
  if (meta) return normaliseCharset(meta[1]);
  const httpEquiv = /<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9_:.-]+)/i.exec(
    head,
  );
  return httpEquiv ? normaliseCharset(httpEquiv[1]) : null;
}

/** Resolve the charset: Content-Type header wins, then <meta>, then utf-8. */
export function sniffCharset(contentType, bytes) {
  return charsetFromContentType(contentType) ?? charsetFromMeta(bytes) ?? 'utf-8';
}

/** Decode bytes with the given charset, falling back to utf-8 when unsupported. */
export function decodeBytes(bytes, charset) {
  const label = normaliseCharset(charset) ?? 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
  ['ensp', ' '],
  ['emsp', ' '],
  ['thinsp', ' '],
  ['zwnj', ''],
  ['zwj', ''],
  ['middot', '·'],
  ['hellip', '…'],
  ['mdash', '—'],
  ['ndash', '–'],
  ['lsquo', '‘'],
  ['rsquo', '’'],
  ['ldquo', '“'],
  ['rdquo', '”'],
  ['laquo', '«'],
  ['raquo', '»'],
  ['times', '×'],
  ['divide', '÷'],
  ['copy', '©'],
  ['reg', '®'],
  ['trade', '™'],
  ['deg', '°'],
  ['bull', '•'],
  ['dagger', '†'],
  ['permil', '‰'],
  ['prime', '′'],
  ['Prime', '″'],
  ['euro', '€'],
  ['pound', '£'],
  ['yen', '¥'],
  ['cent', '¢'],
  ['sect', '§'],
  ['para', '¶'],
  ['plusmn', '±'],
  ['frac12', '½'],
  ['frac14', '¼'],
  ['frac34', '¾'],
  ['sup2', '²'],
  ['sup3', '³'],
]);

export function decodeEntities(input) {
  if (typeof input !== 'string' || input.indexOf('&') === -1) return input ?? '';
  return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      // Preserve invalid Unicode entities.
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      if (code >= 0xd800 && code <= 0xdfff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES.get(body) ?? NAMED_ENTITIES.get(body.toLowerCase());
    return named ?? match;
  });
}

/** Strip tags, decode entities, collapse whitespace. For titles/snippets. */
export function htmlToText(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// robots.txt checks require WEB_TOOLS_RESPECT_ROBOTS=1.

const RESPECT_ROBOTS = process.env.WEB_TOOLS_RESPECT_ROBOTS === '1';
const robotsCache = new Map(); // origin -> rules[]

/** Parse the `User-agent: *` group. Other groups are ignored. */
export function parseRobotsTxt(text) {
  const rules = [];
  let applies = false;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'user-agent') {
      applies = value === '*';
    } else if (applies && (field === 'disallow' || field === 'allow')) {
      rules.push({ allow: field === 'allow', path: value });
    }
  }
  return rules;
}

/** Longest matching path rule wins; no match means allowed. */
export function robotsAllowsPath(rules, pathname) {
  let best = null;
  for (const rule of rules) {
    if (rule.path === '') {
      if (!rule.allow) continue; // "Disallow:" with no value disallows nothing
    } else if (!pathname.startsWith(rule.path)) {
      continue;
    }
    if (best === null || rule.path.length > best.path.length) best = rule;
  }
  return best === null ? true : best.allow;
}

// Network failure details are available in fetch's nested cause.

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);
const CONNECT_TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const CONNECT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'EPIPE',
  'UND_ERR_SOCKET',
]);

/** The most specific message available: the cause's, else the wrapper's. */
function causeMessage(err) {
  const cause = err?.cause;
  if (typeof cause?.message === 'string' && cause.message.trim()) return cause.message.trim();
  if (typeof err?.message === 'string' && err.message.trim()) return err.message.trim();
  return String(err);
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}

/** Classify network failures; return null for caller-managed aborts. */
export function classifyFetchError(err, url) {
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return null;

  const code = err?.cause?.code ?? err?.code;
  const host = hostOf(url);
  const detail = causeMessage(err);

  if (DNS_CODES.has(code)) {
    return { code: 'DNS_FAILURE', message: `Could not resolve ${host} (${code}).` };
  }
  if (CONNECT_TIMEOUT_CODES.has(code)) {
    return {
      code: 'CONNECT_TIMEOUT',
      message:
        `Timed out connecting to ${host} (${code}). The host did not accept a ` +
        `connection in time — it may be unreachable from this network or blocked by a firewall. ${detail}`,
    };
  }
  if (CONNECT_CODES.has(code)) {
    return { code: 'CONNECTION_FAILED', message: `Connection to ${host} failed (${code}). ${detail}` };
  }
  return {
    code: 'REQUEST_FAILED',
    message: `Request to ${host} failed${code ? ` (${code})` : ''}: ${detail}`,
  };
}

/** Whether the caller's robots policy permits fetching this URL. Fails open. */
export async function robotsAllows(rawUrl) {
  if (!RESPECT_ROBOTS) return true;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return true;
  }
  const origin = parsed.origin;
  if (!robotsCache.has(origin)) {
    let rules = [];
    try {
      const res = await fetch(new URL('/robots.txt', origin), {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(8000),
      });
      // A missing or unreadable robots.txt means "no restrictions".
      if (res.ok) rules = parseRobotsTxt(await res.text());
    } catch {
      rules = [];
    }
    robotsCache.set(origin, rules);
  }
  return robotsAllowsPath(robotsCache.get(origin), parsed.pathname);
}

async function readCapped(response, maxBytes) {
  if (!response.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total >= maxBytes) {
        truncated = true;
        break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
  const size = Math.min(total, maxBytes);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= size) break;
    const take = Math.min(chunk.length, size - offset);
    out.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  return { bytes: out, truncated };
}

/** GET a URL with bounded redirects, timeout and download size. */
export async function httpGet(rawUrl, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = MAX_BYTES,
    headers = {},
    throttleMs = 800,
    followRedirects = true,
  } = options;

  const start = Date.now();
  const initial = parseUrl(rawUrl);
  let current = initial.href;
  const visited = new Set();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (visited.has(current)) {
        throw new HttpError('REDIRECT_LOOP', `Redirect loop detected at ${current}`);
      }
      visited.add(current);

      if (!ALLOW_PRIVATE && isPrivateHost(new URL(current).hostname)) {
        throw new HttpError(
          'PRIVATE_ADDRESS',
          `Refusing to fetch the private/loopback address ${new URL(current).host}. ` +
            'Set WEB_TOOLS_ALLOW_PRIVATE=1 to allow local addresses.',
          { url: current },
        );
      }

      if (!(await robotsAllows(current))) {
        throw new HttpError(
          'ROBOTS_DISALLOWED',
          `robots.txt for ${new URL(current).origin} disallows ${new URL(current).pathname}. ` +
            'Unset WEB_TOOLS_RESPECT_ROBOTS to ignore robots.txt.',
          { url: current },
        );
      }

      await throttle(throttleMs);

      try {
        response = await fetch(current, {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'User-Agent': USER_AGENT,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            ...headers,
          },
        });
      } catch (err) {
        if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
          throw new HttpError('TIMEOUT', `Request timed out after ${Date.now() - start}ms`, {
            url: current,
          });
        }
        const failure = classifyFetchError(err, current);
        if (!failure) {
          throw new HttpError('REQUEST_FAILED', `Request failed: ${err?.message ?? String(err)}`, {
            url: current,
          });
        }
        throw new HttpError(failure.code, failure.message, { url: current });
      }

      if (!REDIRECT_STATUS.has(response.status) || !followRedirects) break;

      const location = response.headers.get('location');
      try {
        await response.body?.cancel();
      } catch {
        /* ignore */
      }
      if (!location) break; // redirect status without a target: treat as final
      if (hop === MAX_REDIRECTS) {
        throw new HttpError('TOO_MANY_REDIRECTS', `Exceeded ${MAX_REDIRECTS} redirects`, {
          url: current,
        });
      }
      current = new URL(location, current).href;
      if (!isAllowedScheme(current)) {
        throw new HttpError('BAD_SCHEME', `Redirected to an unsupported scheme: ${current}`);
      }
    }

    const { bytes, truncated } = await readCapped(response, maxBytes);
    const contentType = response.headers.get('content-type') ?? '';
    const charset = sniffCharset(contentType, bytes);

    return {
      status: response.status,
      statusText: response.statusText,
      finalUrl: current,
      contentType,
      charset,
      bytes,
      truncated,
      elapsedMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}
