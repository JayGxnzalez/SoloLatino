/**
 * SoloLatino (sololatino.net) — Sora / Luna / Shirox source module
 * Author: Jay  |  icon: https://avatars.githubusercontent.com/JayGxnzalez?s=400
 * v1.0.0
 *
 * Architecture (reverse-engineered 2026-07-18):
 *   1. sololatino detail/episode page  ->  exposes TMDB/IMDb id (imdb.com/title/tt########)
 *   2. player embed host: https://player.pelisserieshoy.com/f/{imdbId}  (embed69 family)
 *        - hotlink protected: MUST send  Referer: https://sololatino.net/
 *        - page contains  _t = '<32-hex page token>'
 *   3. POST https://player.pelisserieshoy.com/s.php  (x-www-form-urlencoded)
 *        a=1 & tok=_t                -> scan: { s:[[label,hash]...], langs_s:{LAT:[...],ESP:[...]}, meta:{content_id,...} }
 *        a=2 & v=<hash> & tok=_t     -> resolve one server:
 *            { type:'mp4',    u:<direct mp4 / mediafire> }   <- AVPlayer-friendly, PREFERRED
 *            { type:'iframe', url:<nested embed> }
 *            { u:<m3u8>, sig:<sig> }                          <- HLS, play via /p.php?url=..&sig=..
 *            errors: {error:'rate_limited'|'busy'(+retry)|'geoblock'|'not_found'} or {type:'error',msg:'no_click'}
 *
 * We deliberately target the DIRECT MP4 first (dodges the isMaster=false / audio-only
 * AVPlayer problem seen on Vidfast/Videasy). HLS via /p.php is a fallback only.
 *
 * NOTE: searchResults / extractDetails / extractEpisodes parsers below are written from
 * the public listing markup and still need to be confirmed against real page HTML
 * (search response + a series season/episode listing were not yet captured). They log
 * verbosely so the shapes surface in Shirox/Proxyman logs. The stream resolver is complete.
 */

var BASE  = 'https://sololatino.net';
var EMBED = 'https://player.pelisserieshoy.com';
var UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1';

/* ---------- cross-platform fetch (fetchv2-first, plain-fetch fallback) ---------- */
async function soraFetch(url, options) {
  options = options || {};
  var method  = options.method  || 'GET';
  var headers = options.headers || {};
  var body    = options.body    || null;
  try {
    // fetchv2 uses positional args; 5th arg `true` per runtime convention
    return await fetchv2(url, headers, method, body, true);
  } catch (e) {
    try {
      return await fetch(url, { method: method, headers: headers, body: body });
    } catch (e2) {
      console.log('[sololatino] soraFetch failed: ' + url + ' :: ' + e2);
      return null;
    }
  }
}

async function toText(res) {
  if (!res) return '';
  if (typeof res === 'string') return res;
  try { return await res.text(); } catch (e) { try { return String(res); } catch (e2) { return ''; } }
}
async function toJson(res) {
  if (!res) return null;
  if (typeof res === 'object' && typeof res.json === 'function') {
    try { return await res.json(); } catch (e) {}
  }
  var t = await toText(res);
  try { return JSON.parse(t); } catch (e) { console.log('[sololatino] toJson parse fail: ' + t.slice(0, 200)); return null; }
}

/* ================================ SEARCH ================================
 * JSON API:  GET /api/search/suggest?q={query}
 *   -> [ { type:'movie'|'serie'|'toon'|'person', title, year, poster, url }, ... ]
 * Keep playable titles (/pelicula/ , /serie/); drop people.
 */
async function searchResults(keyword) {
  console.log('[sololatino v1.0.0] search: ' + keyword);
  var results = [];
  try {
    var url = BASE + '/api/search/suggest?q=' + encodeURIComponent(keyword);
    var data = await toJson(await soraFetch(url, {
      headers: { 'User-Agent': UA, 'Referer': BASE + '/', 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
    }));
    if (Array.isArray(data)) {
      for (var i = 0; i < data.length; i++) {
        var it = data[i];
        if (!it || !it.url) continue;
        if (it.type === 'person' || it.url.indexOf('/persona/') !== -1) continue;
        if (it.url.indexOf('/pelicula/') === -1 && it.url.indexOf('/serie/') === -1) continue;
        var t = it.title || slugTitle(it.url);
        if (it.year && String(it.year).match(/^\d{4}$/)) t += ' (' + it.year + ')';
        results.push({ title: t, image: it.poster || '', href: it.url });
      }
    } else {
      console.log('[sololatino] search: unexpected payload');
    }
  } catch (e) { console.log('[sololatino] search error: ' + e); }
  console.log('[sololatino] search results=' + results.length);
  return JSON.stringify(results);
}

function slugTitle(href) {
  var s = href.split('/').pop().replace(/-/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ================================ DETAILS ================================ */
async function extractDetails(url) {
  console.log('[sololatino v1.0.0] details: ' + url);
  var details = { description: '', aliases: '', airdate: '' };
  try {
    var html = await toText(await soraFetch(url, { headers: { 'User-Agent': UA, 'Referer': BASE + '/' } }));
    var desc = (html.match(/<meta\s+name="description"\s+content="([^"]+)"/i) ||
                html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i) || [])[1];
    if (desc) details.description = decodeEntities(desc);
    var year = (html.match(/Estreno[\s\S]{0,60}?(\d{4})/i) || html.match(/\b(19|20)\d{2}\b/) || [])[0];
    if (year) details.airdate = year;
  } catch (e) { console.log('[sololatino] details error: ' + e); }
  return JSON.stringify([details]);
}

/* ================================ EPISODES ================================
 * Movies -> single entry (the movie url itself).
 * Series -> parse ep-item anchors from the /serie/{slug} HTML:
 *   <a href=".../temporada-N/episodio-M" class="ep-item ...">
 *     <p class="ep-num">E1</p>
 *     <p class="text-sm font-semibold ...">Visiones ardientes</p>
 * Seasons live in <div data-season-panel="N">. Numbered as a running index across seasons.
 */
async function extractEpisodes(url) {
  console.log('[sololatino v1.0.0] episodes: ' + url);
  var episodes = [];
  try {
    if (url.indexOf('/pelicula/') !== -1) {
      episodes.push({ href: url, number: 1, title: 'Película' });
      return JSON.stringify(episodes);
    }

    var html = await toText(await soraFetch(url, { headers: { 'User-Agent': UA, 'Referer': BASE + '/' } }));
    console.log('[sololatino] series html len=' + html.length);

    var re = /href="(https?:\/\/sololatino\.net\/serie\/[a-z0-9\-]+\/temporada-(\d+)\/episodio-(\d+))"[\s\S]{0,600}?ep-num">\s*E?(\d+)\s*<\/p>[\s\S]{0,200}?<p class="text-sm[^>]*>\s*([\s\S]*?)\s*<\/p>/gi;
    var m, seen = {}, list = [];
    while ((m = re.exec(html)) !== null) {
      if (seen[m[1]]) continue; seen[m[1]] = 1;
      list.push({
        href: m[1],
        season: parseInt(m[2], 10),
        ep: parseInt(m[3], 10),
        title: decodeEntities((m[5] || '').replace(/\s+/g, ' ').trim())
      });
    }

    // Fallback: bare episode links if the rich pattern misses (markup drift).
    if (!list.length) {
      var re2 = /href="(https?:\/\/sololatino\.net\/serie\/[a-z0-9\-]+\/temporada-(\d+)\/episodio-(\d+))"/gi;
      while ((m = re2.exec(html)) !== null) {
        if (seen[m[1]]) continue; seen[m[1]] = 1;
        list.push({ href: m[1], season: parseInt(m[2], 10), ep: parseInt(m[3], 10), title: '' });
      }
    }

    list.sort(function (a, b) { return a.season - b.season || a.ep - b.ep; });
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var label = 'S' + e.season + 'E' + e.ep + (e.title ? ' · ' + e.title : '');
      episodes.push({ href: e.href, number: i + 1, title: label });
    }
    console.log('[sololatino] episodes found=' + episodes.length);
  } catch (e) { console.log('[sololatino] episodes error: ' + e); }
  return JSON.stringify(episodes);
}

/* ============================== STREAM URL ============================== */
async function extractStreamUrl(url) {
  console.log('[sololatino v1.0.0] stream: ' + url);
  try {
    // 1) Load the sololatino page and pull the IMDb id (pelisserieshoy embed key).
    var pageHtml = await toText(await soraFetch(url, { headers: { 'User-Agent': UA, 'Referer': BASE + '/' } }));
    var imdb = (pageHtml.match(/imdb\.com\/title\/(tt\d+)/i) || [])[1];
    console.log('[sololatino] imdb=' + imdb);
    if (!imdb) {
      console.log('[sololatino] no imdb id on page — cannot key embed');
      return JSON.stringify({ streams: [], subtitles: '', subtitlesHeaders: {}, allSubtitles: [] });
    }

    var embedUrl = EMBED + '/f/' + imdb;

    // 2) Load embed page WITH the sololatino Referer (hotlink protected) and scrape _t.
    var embedHtml = await toText(await soraFetch(embedUrl, {
      headers: { 'User-Agent': UA, 'Referer': BASE + '/', 'Accept': 'text/html' }
    }));
    var tok = (embedHtml.match(/_t\s*=\s*['"]([a-f0-9]{32})['"]/i) || [])[1];
    console.log('[sololatino] embed tok=' + tok + ' htmlLen=' + embedHtml.length);
    if (!tok) {
      console.log('[sololatino] no _t token in embed page (referer/hotlink issue?)');
      return JSON.stringify({ streams: [], subtitles: '', subtitlesHeaders: {}, allSubtitles: [] });
    }

    // 3) Scan (optional): gives the server list + meta. Non-fatal — the download path
    //    below only needs the token, so we don't bail if the scan is empty.
    var scan = await sphp(embedUrl, { a: '1', tok: tok });
    console.log('[sololatino] scan raw=' + JSON.stringify(scan).slice(0, 400));

    var streams = [];

    // PRIMARY (ungated): the "Directo" download button. a=dlshort_mf + tok only — no
    //   no_click gate — returns a short link that redirects through /p.php -> MediaFire.
    var dm = await sphp(embedUrl, { a: 'dlshort_mf', tok: tok });
    console.log('[sololatino] dlshort_mf -> ' + JSON.stringify(dm).slice(0, 300));
    var shortUrl = dm && (dm.short || dm.u || dm.url || dm.mf_short);
    if (shortUrl) {
      streams.push({ title: 'Directo', streamUrl: absUrl(shortUrl),
        headers: { 'Referer': embedUrl, 'User-Agent': UA, 'Origin': EMBED }, subtitles: [], _mp4: true });
    }

    // SECONDARY (best-effort): per-server player resolve for extra language/quality options.
    //   These go through the a=2 no_click gate and may fail; that's fine, PRIMARY covers us.
    if (scan && scan.s && scan.s.length) {
      var groups = [];
      if (scan.langs_s) {
        if (scan.langs_s.LAT) groups.push({ lang: 'LAT', list: scan.langs_s.LAT });
        if (scan.langs_s.ESP) groups.push({ lang: 'ESP', list: scan.langs_s.ESP });
        for (var k in scan.langs_s) {
          if (k !== 'LAT' && k !== 'ESP') groups.push({ lang: k, list: scan.langs_s[k] });
        }
      }
      if (!groups.length) groups.push({ lang: '', list: scan.s });

      for (var g = 0; g < groups.length; g++) {
        var grp = groups[g];
        var resolved = await Promise.all(grp.list.map(function (srv) {
          return resolveServer(embedUrl, tok, srv[1], srv[0], grp.lang);
        }));
        for (var i = 0; i < resolved.length; i++) if (resolved[i]) streams.push(resolved[i]);
      }
    }

    // Sort: direct mp4 first (AVPlayer-friendly), HLS after.
    streams.sort(function (a, b) { return (a._mp4 ? 0 : 1) - (b._mp4 ? 0 : 1); });
    for (var s = 0; s < streams.length; s++) delete streams[s]._mp4;

    console.log('[sololatino] streams resolved=' + streams.length);
    return JSON.stringify({ streams: streams, subtitles: '', subtitlesHeaders: {}, allSubtitles: [] });
  } catch (e) {
    console.log('[sololatino] stream error: ' + e);
    return JSON.stringify({ streams: [], subtitles: '', subtitlesHeaders: {}, allSubtitles: [] });
  }
}

/* Resolve a single server hash via  POST /s.php a=2. Handles the no_click retry. */
async function resolveServer(embedUrl, tok, hash, label, lang) {
  try {
    var d = await sphp(embedUrl, { a: '2', v: hash, tok: tok });
    console.log('[sololatino] a2 ' + label + '/' + lang + ' -> ' + JSON.stringify(d).slice(0, 300));

    // Clear the human-gesture gate if present: ping click, retry with r=1 (a couple attempts).
    var tries = 0;
    while (d && d.type === 'error' && d.msg === 'no_click' && tries < 2) {
      await sphp(embedUrl, { a: 'click', tok: tok, v: hash });
      d = await sphp(embedUrl, { a: '2', v: hash, tok: tok, r: '1' });
      console.log('[sololatino] a2-retry ' + label + ' -> ' + JSON.stringify(d).slice(0, 300));
      tries++;
    }

    if (!d) { console.log('[sololatino] srv ' + label + ' null response'); return null; }

    if (d.error) { console.log('[sololatino] srv ' + label + ' error=' + d.error); return null; }
    if (d.type === 'error') { console.log('[sololatino] srv ' + label + ' type-error msg=' + d.msg); return null; }

    var title = (label || 'Server') + (lang ? ' (' + lang + ')' : '');
    var hdrs = { 'Referer': embedUrl, 'User-Agent': UA, 'Origin': EMBED };

    if (d.type === 'mp4' && d.u) {
      return { title: title + ' · Directo', streamUrl: absUrl(d.u), headers: hdrs, subtitles: [], _mp4: true };
    }
    if (d.type === 'iframe' && d.url) {
      // Nested embed host — surface the URL; a downstream extractor can be added if needed.
      console.log('[sololatino] srv ' + label + ' nested iframe: ' + d.url);
      return { title: title + ' · Embed', streamUrl: absUrl(d.url), headers: hdrs, subtitles: [], _mp4: false };
    }
    if (d.u) {
      var out;
      if (/^https?:\/\//i.test(d.u) || d.u.charAt(0) === '/') {
        // Already a full or root-relative URL (e.g. /p.php?v=hash or a direct mediafire link) — use as-is.
        out = absUrl(d.u);
      } else {
        // Raw external m3u8 that must go through the signed proxy.
        out = EMBED + '/p.php?url=' + encodeURIComponent(d.u) + '&sig=' + encodeURIComponent(d.sig || '') +
              (d.ctx ? '&ctx=' + encodeURIComponent(d.ctx) : '');
      }
      var isMp4 = /\.mp4(\?|$)/i.test(out) || /mediafire/i.test(out);
      return { title: title + (isMp4 ? ' · Directo' : ' · HLS'), streamUrl: out, headers: hdrs, subtitles: [], _mp4: isMp4 };
    }
    console.log('[sololatino] srv ' + label + ' unhandled shape keys=' + Object.keys(d).join(','));
    return null;
  } catch (e) { console.log('[sololatino] resolveServer error: ' + e); return null; }
}

/* POST helper for player.pelisserieshoy.com/s.php (x-www-form-urlencoded). */
async function sphp(embedUrl, params) {
  var parts = [];
  for (var k in params) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
  var body = parts.join('&');
  var res = await soraFetch(EMBED + '/s.php', {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Origin': EMBED,
      'Referer': embedUrl,
      'X-Requested-With': 'XMLHttpRequest'
    },
    body: body
  });
  return await toJson(res);
}

/* ---------- tiny helpers ---------- */
function absUrl(u) {
  if (!u) return u;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.charAt(0) === '/') return EMBED + u;
  return u;
}
function decodeEntities(str) {
  if (!str) return '';
  return str.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
            .replace(/&#8217;/g, '\u2019').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}
