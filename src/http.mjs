// HTTP requests with redirects, size limits, charset decoding and throttling.

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch } from 'undici';

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

function isPrivateIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const parts = m.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local, includes cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/** Expand an IPv6 literal to eight 16-bit words, or null if malformed. */
function expandIPv6(input) {
  let host = String(input ?? '').toLowerCase();
  const zone = host.indexOf('%');
  if (zone !== -1) host = host.slice(0, zone); // strip the fe80::1%eth0 scope
  if (!host.includes(':')) return null;

  if (host.includes('.')) {
    // Embedded IPv4 (::ffff:192.168.1.1) becomes two hex groups.
    const lastColon = host.lastIndexOf(':');
    const v4 = host.slice(lastColon + 1);
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v4);
    if (!m) return null;
    const [a, b, c, d] = m.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return null;
    host = `${host.slice(0, lastColon)}:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = host.split('::');
  if (halves.length > 2) return null;
  const split = (part) => (part === '' ? [] : part.split(':'));
  const head = split(halves[0]);
  const tail = halves.length === 2 ? split(halves[1]) : [];
  if ([...head, ...tail].some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  if (halves.length === 1) {
    return head.length === 8 ? head.map((group) => Number.parseInt(group, 16)) : null;
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [
    ...head.map((group) => Number.parseInt(group, 16)),
    ...new Array(missing).fill(0),
    ...tail.map((group) => Number.parseInt(group, 16)),
  ];
}

function isPrivateIPv6(host) {
  const words = expandIPv6(host);
  if (!words) return false;
  // ::, ::1 and IPv4-mapped/compatible forms: judge the embedded IPv4.
  if (words.slice(0, 5).every((word) => word === 0) && (words[5] === 0 || words[5] === 0xffff)) {
    const v4 = `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`;
    return isPrivateIPv4(v4);
  }
  if ((words[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((words[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((words[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  return false;
}

export function isPrivateHost(hostname) {
  const host = String(hostname ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host.includes(':')) return isPrivateIPv6(host);
  return isPrivateIPv4(host);
}

/**
 * Resolve a URL hostname and reject private/loopback targets.
 *
 * Checking the hostname alone is not enough: a public DNS name can point at an
 * internal address, which would let a page steer the fetch into a LAN or
 * loopback service. Every resolved address is checked instead.
 */
export async function resolveHostAddresses(hostname) {
  const host = String(hostname ?? '').replace(/^\[|\]$/g, '');
  if (!host) throw new HttpError('BAD_URL', 'URL has no hostname.');

  const family = isIP(host);
  if (family) {
    if (!ALLOW_PRIVATE && isPrivateHost(host)) {
      throw new HttpError(
        'PRIVATE_ADDRESS',
        `Refusing to connect to the private/loopback address ${host}. ` +
          'Set WEB_TOOLS_ALLOW_PRIVATE=1 to allow local addresses.',
        { host },
      );
    }
    return [{ address: host, family }];
  }

  if (!ALLOW_PRIVATE && isPrivateHost(host)) {
    throw new HttpError(
      'PRIVATE_ADDRESS',
      `Refusing to connect to ${host}. Set WEB_TOOLS_ALLOW_PRIVATE=1 to allow local addresses.`,
      { host },
    );
  }

  let addresses;
  try {
    addresses = await dnsLookup(host, { all: true, verbatim: true });
  } catch (err) {
    const code = err?.code ?? 'DNS_ERROR';
    throw new HttpError('DNS_FAILURE', `Could not resolve ${host} (${code}).`, { host });
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new HttpError('DNS_FAILURE', `Could not resolve ${host} (no addresses returned).`, { host });
  }

  if (!ALLOW_PRIVATE) {
    const blocked = addresses.find((entry) => isPrivateHost(entry.address));
    if (blocked) {
      throw new HttpError(
        'PRIVATE_ADDRESS',
        `Refusing to fetch ${host}: it resolves to the private/loopback address ${blocked.address}. ` +
          'Set WEB_TOOLS_ALLOW_PRIVATE=1 to allow local addresses.',
        { host, address: blocked.address },
      );
    }
  }
  return addresses;
}

/**
 * A net lookup replacement that only returns addresses already validated by
 * resolveHostAddresses. Pinning the connection to the checked addresses stops
 * DNS rebinding between the check and the socket connect.
 */
export function pinnedLookup(addresses) {
  const entries = addresses.map(({ address, family }) => ({ address, family }));
  return (hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const family = Number(options?.family) || 0;
    const candidates = family ? entries.filter((entry) => entry.family === family) : entries;
    const list = candidates.length > 0 ? candidates : entries;
    if (list.length === 0) {
      callback(new Error(`No validated address for ${hostname}.`));
      return;
    }
    if (options?.all) callback(null, list);
    else callback(null, list[0].address, list[0].family);
  };
}

function dispatcherFor(addresses) {
  return new Agent({ connect: { lookup: pinnedLookup(addresses) } });
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

/**
 * Whether the caller's robots policy permits fetching this URL. Fails open.
 * `addresses` must be the validated addresses of the URL's host, so the
 * robots.txt request is pinned to the same target.
 */
export async function robotsAllows(rawUrl, addresses = null) {
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
    const agent = addresses ? dispatcherFor(addresses) : null;
    try {
      const res = await fetch(new URL('/robots.txt', origin), {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(8000),
        ...(agent ? { dispatcher: agent } : {}),
      });
      // A missing or unreadable robots.txt means "no restrictions".
      if (res.ok) rules = parseRobotsTxt(await res.text());
      else await res.body?.cancel();
    } catch {
      rules = [];
    } finally {
      try {
        agent?.destroy();
      } catch {
        /* already gone */
      }
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
      if (total + value.length >= maxBytes) {
        const take = Math.max(0, maxBytes - total);
        if (take > 0) chunks.push(value.subarray(0, take));
        total = maxBytes;
        // Truncated only if the body really continued past the cap: a body of
        // exactly maxBytes is complete, so peek for one more chunk first.
        truncated = value.length > take;
        if (!truncated) {
          const next = await reader.read();
          truncated = !next.done;
        }
        break;
      }
      chunks.push(value);
      total += value.length;
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

/** One fetch, with the shared network-failure classification. */
async function fetchOnce(url, init, start) {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      throw new HttpError('TIMEOUT', `Request timed out after ${Date.now() - start}ms`, { url });
    }
    const failure = classifyFetchError(err, url);
    if (!failure) {
      throw new HttpError('REQUEST_FAILED', `Request failed: ${err?.message ?? String(err)}`, { url });
    }
    throw new HttpError(failure.code, failure.message, { url });
  }
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
  let activeAgent = null;

  try {
    let response = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (visited.has(current)) {
        throw new HttpError('REDIRECT_LOOP', `Redirect loop detected at ${current}`);
      }
      visited.add(current);

      // Resolve first and pin the connection to the checked addresses: a
      // hostname check alone lets a public name point at an internal IP.
      const addresses = await resolveHostAddresses(new URL(current).hostname);

      if (!(await robotsAllows(current, addresses))) {
        throw new HttpError(
          'ROBOTS_DISALLOWED',
          `robots.txt for ${new URL(current).origin} disallows ${new URL(current).pathname}. ` +
            'Unset WEB_TOOLS_RESPECT_ROBOTS to ignore robots.txt.',
          { url: current },
        );
      }

      await throttle(throttleMs);

      const agent = dispatcherFor(addresses);
      let hopResponse;
      try {
        hopResponse = await fetchOnce(
          current,
          {
            redirect: 'manual',
            signal: controller.signal,
            dispatcher: agent,
            headers: {
              'User-Agent': USER_AGENT,
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
              'Accept-Encoding': 'gzip, deflate, br',
              ...headers,
            },
          },
          start,
        );
      } catch (err) {
        agent.destroy();
        throw err;
      }

      if (!REDIRECT_STATUS.has(hopResponse.status) || !followRedirects) {
        response = hopResponse;
        activeAgent = agent;
        break;
      }

      const location = hopResponse.headers.get('location');
      if (!location) {
        // Redirect status without a target: treat as final.
        response = hopResponse;
        activeAgent = agent;
        break;
      }
      try {
        await hopResponse.body?.cancel();
      } catch {
        /* ignore */
      }
      agent.destroy();

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

    if (!response) {
      throw new HttpError('REQUEST_FAILED', 'No response was received.', { url: current });
    }

    let bytes;
    let truncated;
    try {
      ({ bytes, truncated } = await readCapped(response, maxBytes));
    } catch (err) {
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        throw new HttpError('TIMEOUT', `Request timed out after ${Date.now() - start}ms`, { url: current });
      }
      throw err;
    }
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
    try {
      activeAgent?.destroy();
    } catch {
      /* already gone */
    }
    clearTimeout(timer);
  }
}

/** POST a JSON body and read a capped response. For API calls, so no redirects. */
export async function httpPost(rawUrl, body, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = MAX_BYTES,
    headers = {},
    throttleMs = 0,
  } = options;

  const start = Date.now();
  const url = parseUrl(rawUrl);
  const addresses = await resolveHostAddresses(url.hostname);

  await throttle(throttleMs);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const agent = dispatcherFor(addresses);

  try {
    const response = await fetchOnce(
      url.href,
      {
        method: 'POST',
        signal: controller.signal,
        dispatcher: agent,
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream, application/json',
          ...headers,
        },
        body: JSON.stringify(body),
      },
      start,
    );

    let bytes;
    let truncated;
    try {
      ({ bytes, truncated } = await readCapped(response, maxBytes));
    } catch (err) {
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        throw new HttpError('TIMEOUT', `Request timed out after ${Date.now() - start}ms`, { url: url.href });
      }
      throw err;
    }
    const contentType = response.headers.get('content-type') ?? '';

    return {
      status: response.status,
      statusText: response.statusText,
      contentType,
      charset: sniffCharset(contentType, bytes),
      bytes,
      truncated,
      elapsedMs: Date.now() - start,
    };
  } finally {
    try {
      agent.destroy();
    } catch {
      /* already gone */
    }
    clearTimeout(timer);
  }
}
