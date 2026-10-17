// Web search through Brave Search API.
import { HttpError, decodeBytes, htmlToText, httpGet } from './http.mjs';

export const DEFAULT_COUNT = 5;
export const MAX_COUNT = 20;
const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

const clampCount = (n) => Math.min(MAX_COUNT, Math.max(1, Number.isFinite(n) ? Math.floor(n) : DEFAULT_COUNT));

export function buildSearchUrl(query, { count = DEFAULT_COUNT, search_lang, country = 'ALL', freshness } = {}) {
  const url = new URL(ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(clampCount(count)));
  url.searchParams.set('country', country);
  // Brave uses zh-hans and zh-hant for Chinese.
  const chinese = /\p{Script=Han}/u.test(query) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(query);
  url.searchParams.set('search_lang', search_lang || (chinese ? 'zh-hans' : 'en'));
  url.searchParams.set('result_filter', 'web');
  url.searchParams.set('text_decorations', 'false');
  url.searchParams.set('spellcheck', 'false');
  if (freshness) url.searchParams.set('freshness', freshness);
  return url.href;
}

/** Parse and deduplicate web results in provider order. */
export function parseBraveResults(data) {
  if (!data || Array.isArray(data) || typeof data !== 'object' ||
      data.type !== 'search' || !data.query || typeof data.query.original !== 'string' ||
      (data.web != null && !Array.isArray(data.web.results))) {
    throw new HttpError('SEARCH_UNPARSEABLE', 'Brave returned an unexpected search response.');
  }

  const items = data.web?.results ?? [];
  const results = [];
  const seen = new Set();
  for (const item of items) {
    if (!item || typeof item.title !== 'string' || typeof item.url !== 'string') continue;
    let url;
    try { url = new URL(item.url); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
    const title = htmlToText(item.title);
    if (!title) continue;
    const key = new URL(url.href);
    key.hash = '';
    if (seen.has(key.href)) continue;
    seen.add(key.href);
    const result = {
      title,
      url: url.href,
      snippet: typeof item.description === 'string' ? htmlToText(item.description).slice(0, 1000) : '',
    };
    // page_age is a publication or modification date.
    if (typeof item.page_age === 'string' && item.page_age.trim()) result.date = item.page_age.trim();
    results.push(result);
  }
  if (items.length > 0 && results.length === 0) {
    throw new HttpError('SEARCH_UNPARSEABLE', 'Brave returned web results, but none contained a usable title and URL.');
  }

  const notes = [];
  if (data.query.altered && data.query.altered !== data.query.original) {
    notes.push(`Brave used an altered query: ${htmlToText(String(data.query.altered))}`);
  }
  if (data.query.bad_results === true) notes.push('Brave flagged these results as low quality; refine the query.');
  if (results.length === 0) notes.push('Brave returned no web results for this query.');
  return { results, note: notes.join(' ') || null };
}

function apiError(status, data) {
  const providerCode = typeof data?.error?.code === 'string' ? data.error.code : '';
  const detail = typeof data?.error?.detail === 'string' ? htmlToText(data.error.detail).slice(0, 400) : '';
  if (status === 401 || status === 403 || /SUBSCRIPTION|TOKEN_INVALID|TOKEN_EXPIRED/.test(providerCode)) {
    return new HttpError('SEARCH_AUTH', 'Brave rejected the API key or subscription. Check BRAVE_SEARCH_API_KEY and the active Search plan.');
  }
  if (providerCode === 'QUOTA_LIMITED') {
    return new HttpError('SEARCH_QUOTA_EXCEEDED', 'Brave Search API quota is exhausted. Check usage and limits in the Brave dashboard.');
  }
  if (status === 429 || providerCode === 'RATE_LIMITED') {
    return new HttpError('SEARCH_RATE_LIMITED', 'Brave Search API rate limit reached. Wait before trying again.');
  }
  return new HttpError('SEARCH_HTTP', `Brave Search API returned HTTP ${status}${providerCode ? ` (${providerCode})` : ''}${detail ? `: ${detail}` : '.'}`);
}

export async function searchBrave(query, options = {}) {
  if (typeof query !== 'string' || !query.trim()) throw new HttpError('BAD_QUERY', 'query must be a non-empty string.');
  const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!apiKey) {
    throw new HttpError('MISSING_API_KEY', 'Set BRAVE_SEARCH_API_KEY in the MCP server environment to use Brave Search. web_fetch does not require a key.');
  }
  if (/[^\x21-\x7e]/.test(apiKey)) {
    throw new HttpError('SEARCH_AUTH', 'BRAVE_SEARCH_API_KEY must be a single ASCII token without whitespace or control characters.');
  }
  try {
    const res = await httpGet(buildSearchUrl(query.trim(), options), {
      timeoutMs: options.timeoutMs,
      throttleMs: 1000,
      followRedirects: false,
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
        'User-Agent': 'web-tools-mcp/0.1.0',
      },
    });
    if (res.truncated) throw new HttpError('SEARCH_UNPARSEABLE', 'Brave response exceeded the download size limit.');
    let data;
    try { data = JSON.parse(decodeBytes(res.bytes, res.charset)); } catch {
      if (res.status >= 200 && res.status < 300) {
        throw new HttpError('SEARCH_UNPARSEABLE', 'Brave returned a successful HTTP status with invalid JSON.');
      }
    }
    if (res.status < 200 || res.status >= 300 || data?.error || data?.type === 'ErrorResponse') {
      throw apiError(res.status, data);
    }
    const parsed = parseBraveResults(data);
    return { ...parsed, results: parsed.results.slice(0, clampCount(options.count)) };
  } catch (err) {
    // Redact API credentials from error messages.
    const message = String(err?.message ?? err).split(apiKey).join('[redacted]');
    throw new HttpError(err instanceof HttpError ? err.code : 'SEARCH_FAILED', message);
  }
}

export function formatSearchResults(query, { results, note }, { count }) {
  const lines = [`Search: ${query}`, `Source: Brave Search API  requested=${count}`];
  if (note) lines.push(`Note: ${note}`);
  lines.push('');
  if (results.length === 0) {
    lines.push('(no results)');
    return lines.join('\n');
  }
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`, `   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    if (r.date) lines.push(`   date (published or updated): ${r.date}`);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}
