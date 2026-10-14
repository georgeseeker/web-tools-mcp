// End-to-end smoke test for web-tools.
//
// Deterministic checks run against fixed fixtures and pure functions; the live
// checks hit the network and can be skipped with SKIP_NETWORK=1.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { JSDOM } from 'jsdom';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  charsetFromContentType,
  charsetFromMeta,
  sniffCharset,
  decodeBytes,
  decodeEntities,
  htmlToText,
  isAllowedScheme,
  isPrivateHost,
  parseRobotsTxt,
  robotsAllowsPath,
} from '../src/http.mjs';
import {
  parseBingRss,
  parseBingResults,
  normalizeResultUrl,
  detectBlock,
  looksLikeNoResults,
  buildSearchUrl,
  MAX_COUNT,
} from '../src/search.mjs';
import { classifyContentType, paginate, htmlToMarkdown, absolutize } from '../src/fetchpage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = path.join(root, 'src', 'server.mjs');
const fixtures = path.join(root, 'test', 'fixtures');
const SKIP_NETWORK = process.env.SKIP_NETWORK === '1';

let passed = 0;
let failed = 0;
function check(name, cond, info = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}${info ? `  [${info}]` : ''}`);
  }
}
function section(title) {
  console.log(`\n${title}`);
}
const read = (f) => fs.readFileSync(path.join(fixtures, f), 'utf8');
const utf8 = (s) => new TextEncoder().encode(s);
const getText = (res) => (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

section('charset detection');
check('charset from Content-Type', charsetFromContentType('text/html; charset=gbk') === 'gbk');
check('charset quoted in Content-Type', charsetFromContentType('text/html; charset="UTF-8"') === 'utf-8');
check('no charset in Content-Type', charsetFromContentType('text/html') === null);
check('no Content-Type', charsetFromContentType(null) === null);
check('gb2312 aliases to gbk', charsetFromContentType('text/html; charset=gb2312') === 'gbk');
check('charset from <meta charset>', charsetFromMeta(utf8('<html><head><meta charset="utf-8">')) === 'utf-8');
check(
  'charset from <meta http-equiv>',
  charsetFromMeta(utf8('<html><head><meta http-equiv="Content-Type" content="text/html; charset=big5">')) === 'big5',
);
check('meta charset honours aliases', charsetFromMeta(utf8('<meta charset=gb2312>')) === 'gbk');
check('no meta charset', charsetFromMeta(utf8('<html><head><title>x</title>')) === null);
check('header wins over meta', sniffCharset('text/html; charset=gbk', utf8('<meta charset="utf-8">')) === 'gbk');
check('defaults to utf-8', sniffCharset('text/html', utf8('<html><body>hi')) === 'utf-8');
check('decodes gbk bytes', decodeBytes(new Uint8Array([0xd6, 0xd0]), 'gbk') === '中');
check('unknown charset falls back to utf-8', decodeBytes(utf8('hi'), 'no-such-charset') === 'hi');

section('HTML entities');
check('named + numeric entities', decodeEntities('a&ensp;b&#0183;c&amp;d&nbsp;e') === 'a b·c&d e');
check('&#0183; is decimal, not octal', decodeEntities('&#0183;') === '·');
check('unknown entity left alone', decodeEntities('x&unknown;y') === 'x&unknown;y');
check('hex entity', decodeEntities('&#x4e2d;') === '中');
check('surrogate entity rejected', decodeEntities('&#xD800;') === '&#xD800;');
check('absurd code point does not throw', decodeEntities('&#9999999;') === '&#9999999;');
check('no ampersand is a fast path', decodeEntities('plain text') === 'plain text');
check('htmlToText strips tags', htmlToText('<b>bold</b> &amp; <i>italic</i>') === 'bold & italic');

section('URL policy and private-address guard');
check('https allowed', isAllowedScheme('https://example.com'));
check('http allowed', isAllowedScheme('http://example.com'));
check('file refused', !isAllowedScheme('file:///C:/Windows/win.ini'));
check('data refused', !isAllowedScheme('data:text/html,hi'));
check('ftp refused', !isAllowedScheme('ftp://example.com'));
check('garbage refused', !isAllowedScheme('not a url'));
check('loopback is private', isPrivateHost('127.0.0.1') && isPrivateHost('127.9.9.9'));
check('localhost is private', isPrivateHost('localhost') && isPrivateHost('foo.localhost'));
check('RFC1918 is private', isPrivateHost('10.0.0.1') && isPrivateHost('192.168.1.1') && isPrivateHost('172.16.0.1'));
check('172.32 is public', !isPrivateHost('172.32.0.1'));
check('link-local / cloud metadata is private', isPrivateHost('169.254.169.254'));
check('CGNAT is private', isPrivateHost('100.64.0.1'));
check('IPv6 loopback is private', isPrivateHost('::1'));
check('IPv4-mapped loopback is private', isPrivateHost('::ffff:127.0.0.1'));
check('public hosts are public', !isPrivateHost('example.com') && !isPrivateHost('93.184.216.34'));

section('robots.txt parsing (opt-in)');
{
  const rules = parseRobotsTxt(
    ['# comment', 'User-agent: BadBot', 'Disallow: /', '', 'User-agent: *', 'Disallow: /private', 'Allow: /private/ok'].join('\n'),
  );
  check('ignores other user-agent groups', rules.length === 2, JSON.stringify(rules));
  check('disallow path blocked', robotsAllowsPath(rules, '/private/x') === false);
  check('allow overrides disallow', robotsAllowsPath(rules, '/private/ok') === true);
  check('unlisted path allowed', robotsAllowsPath(rules, '/public') === true);
  check('empty rules allow everything', robotsAllowsPath([], '/anything') === true);
}

section('content-type classification');
check('html', classifyContentType('text/html; charset=utf-8') === 'html');
check('xhtml', classifyContentType('application/xhtml+xml') === 'html');
check('missing content-type treated as html', classifyContentType('') === 'html');
check('plain text', classifyContentType('text/plain') === 'text');
check('json', classifyContentType('application/json') === 'text');
check('rss xml', classifyContentType('application/rss+xml') === 'text');
check('png is binary', classifyContentType('image/png') === 'binary');
check('pdf is binary', classifyContentType('application/pdf') === 'binary');
check('octet-stream is binary', classifyContentType('application/octet-stream') === 'binary');

section('pagination');
{
  const p = paginate('0123456789', 2, 4);
  check('slice honours start and length', p.slice === '2345', p.slice);
  check('reports remaining', p.remaining === 4 && p.hasMore === true);
  const last = paginate('0123456789', 8, 4);
  check('final page has no more', last.slice === '89' && last.hasMore === false);
  const clamped = paginate('abc', 99, 10);
  check('start beyond end yields empty', clamped.slice === '' && clamped.hasMore === false);
}

section('Bing RSS decoder (fixture)');
{
  const parsed = parseBingRss(read('bing-results.rss'));
  check('rss yields 10 results', parsed.results.length === 10, String(parsed.results.length));
  check('rss strategy reported', parsed.strategy === 'rss', parsed.strategy);
  check(
    'every result has title and absolute url',
    parsed.results.every((r) => r.title.length > 0 && /^https?:\/\//.test(r.url)),
  );
  check('no bing/microsoft self-links', parsed.results.every((r) => !/(^|\.)(bing|microsoft)\.com/.test(r.url)));
  check('urls are not ck/a wrappers', parsed.results.every((r) => !/bing\.com\/ck\/a/.test(r.url)));
  check('pubDate surfaced', parsed.results.some((r) => typeof r.published === 'string' && r.published.length > 0));
  check('snippets present', parsed.results.some((r) => r.snippet.length > 0));
}

section('Bing HTML decoder (fixture)');
{
  const parsed = parseBingResults(read('bing-sample.html'));
  check('sample parsed via b_algo', parsed.strategy === 'b_algo', parsed.strategy);
  check('sample yields 3 results', parsed.results.length === 3, String(parsed.results.length));
  check('every result has title and absolute url', parsed.results.every((r) => r.title.length > 0 && /^https?:\/\//.test(r.url)));
  check('entities decoded in titles', parsed.results.every((r) => !/&(amp|ensp|#\d+);/.test(r.title)));
  check('snippets present', parsed.results.some((r) => r.snippet.length > 0));
  check('bing/microsoft self-links filtered', parsed.results.every((r) => !/bing\.com|microsoft\.com/.test(r.url)));

  const blocked = read('bing-blocked.html');
  check('blocked page yields no results', parseBingResults(blocked).results.length === 0);
  check('blocked page detected', detectBlock(blocked, 200) !== null, String(detectBlock(blocked, 200)));
  check('HTTP 429 detected', detectBlock('', 429) !== null);
  check('HTTP 503 detected', detectBlock('', 503) !== null);
  check('normal page is not flagged', detectBlock(read('bing-sample.html'), 200) === null);
  check('explicit no-results text recognised', looksLikeNoResults('<div>There are no results for zzz</div>'));
  check('a results page is not "no results"', !looksLikeNoResults(read('bing-sample.html')));
}

section('normalizeResultUrl');
{
  const wrapped =
    'https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly9kb2NzLnB5dGhvbi5vcmcvMy9saWJyYXJ5L2FzeW5jaW8uaHRtbA&ntb=1';
  check('unwraps the ck/a redirect', normalizeResultUrl(wrapped) === 'https://docs.python.org/3/library/asyncio.html', String(normalizeResultUrl(wrapped)));
  check('plain https passes through', normalizeResultUrl('https://example.com/x') === 'https://example.com/x');
  check('javascript: dropped', normalizeResultUrl('javascript:void(0)') === null);
  check('relative dropped', normalizeResultUrl('/search?q=x') === null);
  check('un-unwrappable ck/a dropped', normalizeResultUrl('https://www.bing.com/ck/a?!&&p=abc') === null);
}

section('buildSearchUrl');
{
  const u = new URL(buildSearchUrl('hello world', { count: 10 }));
  check('query encoded', u.searchParams.get('q') === 'hello world');
  check('count passed', u.searchParams.get('count') === '10');
  check('no paging params emitted', !u.searchParams.has('first'));
  check('rss flag adds format=rss', new URL(buildSearchUrl('x', { rss: true })).searchParams.get('format') === 'rss');
  check('no format by default', !new URL(buildSearchUrl('x')).searchParams.has('format'));
  check('max count is 10', MAX_COUNT === 10);
  check(
    'ensearch=1 always set (zh query segmentation fix)',
    u.searchParams.get('ensearch') === '1' && new URL(buildSearchUrl('x', { rss: true })).searchParams.get('ensearch') === '1',
  );
}

section('Markdown conversion');
{
  const longBody = '<p>' + 'word '.repeat(120) + '</p>';
  const articlePage =
    '<html><head><title>T</title></head><body><article><h1>Hi</h1><p>Body &amp; text</p>' +
    longBody +
    '<p><a href="/rel">relative</a></p>' +
    '<script>alert(1)</script><style>.x{color:red}</style>' +
    '<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table></article></body></html>';
  const { markdown, title } = htmlToMarkdown(articlePage, 'https://example.com/dir/page');
  check('title extracted', title === 'T', title);
  check('heading converted', markdown.includes('# Hi'), markdown.slice(0, 60));
  check('entities decoded', markdown.includes('Body & text'));
  check('script content never leaks', !markdown.includes('alert(1)'), markdown.slice(0, 120));
  check('style content never leaks', !markdown.includes('color:red'));
  check('gfm table converted', markdown.includes('| a') && markdown.includes('| 1'));
  check('relative link absolutised', markdown.includes('https://example.com/rel'), markdown.slice(0, 200));

  // Readability is permissive: it still parses short pages, and its own link
  // rewriting handles them (this also proves jsdom got the page url).
  const shortPage = htmlToMarkdown(read('no-article.html'), 'https://example.com/base/');
  check('short page content present', shortPage.markdown.includes('简短内容'), shortPage.markdown);
  check(
    'relative link absolutised (honours <base href>)',
    shortPage.markdown.includes('https://example.com/guide/x'),
    shortPage.markdown,
  );

  // A page Readability genuinely cannot use still has to fall back, not throw.
  const rejected = htmlToMarkdown('<html><body><form><input></form></body></html>', 'https://example.com/');
  check('unparseable page falls back to body', rejected.via === 'body', rejected.via);
}

section('absolutize (body-fallback link rewriting)');
{
  const dom = new JSDOM(
    '<body><a id="rel" href="/x">a</a><a id="abs" href="https://other.test/y">b</a>' +
      '<a id="frag" href="#top">c</a><a id="mail" href="mailto:a@b.c">d</a>' +
      '<a id="data" href="data:text/plain,hi">e</a><img id="img" src="i.png">' +
      '<a id="proto" href="//cdn.test/z">f</a></body>',
  );
  const { body } = dom.window.document;
  absolutize(body, 'https://example.com/dir/page');
  const attr = (id, a = 'href') => dom.window.document.getElementById(id).getAttribute(a);
  check('relative path resolved', attr('rel') === 'https://example.com/x', attr('rel'));
  check('absolute url untouched', attr('abs') === 'https://other.test/y');
  check('protocol-relative resolved', attr('proto') === 'https://cdn.test/z', attr('proto'));
  check('fragment left alone', attr('frag') === '#top');
  check('mailto left alone', attr('mail') === 'mailto:a@b.c');
  check('data: left alone', attr('data') === 'data:text/plain,hi');
  check('img src resolved', attr('img', 'src') === 'https://example.com/dir/i.png', attr('img', 'src'));
  dom.window.close();
}

// ---------------------------------------------------------------------------
// Live protocol tests through the real stdio server
// ---------------------------------------------------------------------------

section('server over stdio');

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: root,
  stderr: 'pipe',
});
const stderrChunks = [];
if (transport.stderr) transport.stderr.on('data', (d) => stderrChunks.push(d));
const client = new Client({ name: 'web-tools-smoke', version: '0.0.0' }, { capabilities: {} });

try {
  await client.connect(transport);

  const tools = await client.listTools();
  const names = (tools.tools ?? []).map((t) => t.name).sort();
  check('exactly two tools', names.length === 2, names.join(','));
  check('tools are web_fetch and web_search', names.join(',') === 'web_fetch,web_search', names.join(','));

  const search = tools.tools.find((t) => t.name === 'web_search');
  const fetchTool = tools.tools.find((t) => t.name === 'web_fetch');
  check('web_search requires query', JSON.stringify(search.inputSchema.required) === '["query"]');
  check('web_search has no page parameter', !('page' in search.inputSchema.properties));
  check('web_search count is capped at 10', search.inputSchema.properties.count.maximum === 10);
  check('web_fetch requires url', JSON.stringify(fetchTool.inputSchema.required) === '["url"]');
  check(
    'web_fetch exposes pagination and raw',
    ['max_length', 'start_index', 'raw'].every((k) => k in fetchTool.inputSchema.properties),
  );

  const unknown = await client.callTool({ name: 'nope', arguments: {} });
  check('unknown tool is an error', unknown.isError === true);

  const noQuery = await client.callTool({ name: 'web_search', arguments: {} });
  check('missing query is an error', noQuery.isError === true);
  check('missing query message is clear', /query/.test(getText(noQuery)), getText(noQuery).slice(0, 80));

  const emptyQuery = await client.callTool({ name: 'web_search', arguments: { query: '   ' } });
  check('blank query is an error', emptyQuery.isError === true);

  const noUrl = await client.callTool({ name: 'web_fetch', arguments: {} });
  check('missing url is an error', noUrl.isError === true);

  const fileUrl = await client.callTool({ name: 'web_fetch', arguments: { url: 'file:///C:/Windows/win.ini' } });
  check('file:// refused', fileUrl.isError === true);
  check('file:// refusal explains the scheme', /http/i.test(getText(fileUrl)), getText(fileUrl).slice(0, 90));

  const dataUrl = await client.callTool({ name: 'web_fetch', arguments: { url: 'data:text/html,hi' } });
  check('data: refused', dataUrl.isError === true);

  const junkUrl = await client.callTool({ name: 'web_fetch', arguments: { url: 'not a url' } });
  check('garbage url refused', junkUrl.isError === true);

  const privateUrl = await client.callTool({ name: 'web_fetch', arguments: { url: 'http://169.254.169.254/latest/meta-data/' } });
  check('cloud metadata address refused', privateUrl.isError === true);
  check('private refusal is explicit', /PRIVATE_ADDRESS/.test(getText(privateUrl)), getText(privateUrl).slice(0, 110));

  const localhost = await client.callTool({ name: 'web_fetch', arguments: { url: 'http://localhost:6379/' } });
  check('localhost refused by default', localhost.isError === true);

  if (SKIP_NETWORK) {
    console.log('\n(SKIP_NETWORK=1 — live checks skipped)');
  } else {
    section('live network checks (failures here mean network, not code)');

    try {
      const res = await client.callTool({ name: 'web_search', arguments: { query: 'claude code', count: 5 } });
      const text = getText(res);
      check('web_search returns results', res.isError !== true && /^\d+\. /m.test(text), text.slice(0, 120));
      check('web_search includes urls', /https?:\/\//.test(text));
      check('web_search urls are unwrapped', !/bing\.com\/ck\/a/.test(text));
    } catch (err) {
      check('web_search live call', false, err.message);
    }

    try {
      // Regression: without ensearch=1 this returned dictionary entries for the
      // single character 机器 instead of anything about machine learning.
      const res = await client.callTool({ name: 'web_search', arguments: { query: '机器学习 入门', count: 5 } });
      const text = getText(res);
      check('multi-word Chinese query returns results', res.isError !== true && /机器学习/.test(text), text.slice(0, 100));
      const firstTitle = (text.match(/^1\. (.+)$/m) ?? [])[1] ?? '';
      check(
        'top hit is about the phrase, not a single character',
        firstTitle.length > 0 && !/^机器[（(]/.test(firstTitle),
        firstTitle.slice(0, 60),
      );
    } catch (err) {
      check('multi-word Chinese query', false, err.message);
    }

    try {
      const res = await client.callTool({ name: 'web_search', arguments: { query: 'zzqqxxvv nonexistent term 9f3a2b' } });
      const text = getText(res);
      check('nonsense query never returns a bare empty list', res.isError === true || /no results|^\d+\. /m.test(text), text.slice(0, 120));
    } catch (err) {
      check('nonsense query handled', false, err.message);
    }

    try {
      const res = await client.callTool({ name: 'web_fetch', arguments: { url: 'https://example.com' } });
      const text = getText(res);
      check('web_fetch returns page text', res.isError !== true && text.includes('Example Domain'), text.slice(0, 120));
      check('web_fetch reports a title', /Title: Example Domain/.test(text));
    } catch (err) {
      check('web_fetch live call', false, err.message);
    }

    try {
      const partA = getText(await client.callTool({ name: 'web_fetch', arguments: { url: 'https://example.com', max_length: 60 } }));
      const partB = getText(
        await client.callTool({ name: 'web_fetch', arguments: { url: 'https://example.com', max_length: 60, start_index: 60 } }),
      );
      check('pagination reports remaining text', /characters remain/.test(partA), partA.slice(-90));
      check('start_index advances to different text', partA !== partB);
      check('over-paginating stops cleanly', /No more|0 characters|remain/.test(getText(
        await client.callTool({ name: 'web_fetch', arguments: { url: 'https://example.com', start_index: 999999 } }),
      )));
    } catch (err) {
      check('web_fetch pagination', false, err.message);
    }

    try {
      const res = await client.callTool({ name: 'web_fetch', arguments: { url: 'https://example.com/favicon.ico' } });
      const text = getText(res);
      check(
        'binary/404 handled explicitly',
        res.isError === true ? /image\/|HTTP 404|Unsupported|binary/i.test(text) : !/[\u0000-\u0008]/.test(text),
        text.slice(0, 100),
      );
    } catch (err) {
      check('binary handling', false, err.message);
    }

    try {
      const res = await client.callTool({ name: 'web_fetch', arguments: { url: 'https://nonexistent-abcxyz-42.invalid/' } });
      check('unresolvable host errors cleanly', res.isError === true, getText(res).slice(0, 120));
    } catch (err) {
      check('unresolvable host handled', false, err.message);
    }
  }
} catch (err) {
  failed += 1;
  console.log(`\nFATAL: ${err?.message ?? err}`);
} finally {
  try {
    await client.close();
  } catch {
    /* already gone */
  }
}

section('stdout hygiene');
{
  const stderrText = Buffer.concat(stderrChunks).toString('utf8');
  check('all stderr lines are namespaced', stderrText.split(/\r?\n/).filter(Boolean).every((l) => l.startsWith('[web-tools]')), stderrText.slice(0, 160));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  const tail = Buffer.concat(stderrChunks).toString('utf8').split(/\r?\n/).slice(-40).join('\n');
  if (tail.trim()) console.log(`--- server stderr (tail) ---\n${tail}`);
  process.exit(1);
}
