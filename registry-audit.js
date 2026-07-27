#!/usr/bin/env node
// registry-audit — check that the things a public registry lists actually exist.
//
//   node registry-audit.js --json https://raw.../mcp-servers.json
//   node registry-audit.js --site https://docs.example.com
//
// WHY: a registry entry that stopped being true looks exactly like one that never stopped.
// There is no error, no exception, no failing test — the row sits there and the first person
// to find out is a user who clicks it. Nobody audits these, because auditing them is boring
// and the absence of a complaint reads as health.
//
// WHAT IT FOUND, so the claim isn't theoretical:
//   · Archestra's MCP catalogue — 887 entries, 830 fine, and **14 pointing at
//     github.com/mcp/ext-apps/**, an org that returns 404 and has never existed. Those rows
//     cannot have come from anywhere real.
//   · Composio's docs — 1,426 pages, 1,362 internal targets, **zero broken**. Clean.
//   · ComfyUI's node registry — 99/99 repos alive, one orphan at 0.1%. Clean.
//
// ⇒ Two nulls for every finding. That ratio is the point: this is a FILTER, not a factory,
// and the nulls are what make the findings worth reading.
//
// It is deliberately polite: HEAD before GET, low concurrency, one pass, a real user-agent.
// An audit, not a scan.
'use strict';
const https = require('node:https');
const http = require('node:http');

const CONC = 6;
const TIMEOUT = 10000;
const UA = 'registry-audit/1.0 (+https://github.com/siliroid/whereruns) checking listed entries resolve';

function req(url, method = 'GET') {
  return new Promise((res) => {
    let u; try { u = new URL(url); } catch { return res({ url, status: 'MALFORMED' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const r = lib.request({
      method, hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, timeout: TIMEOUT, headers: { 'user-agent': UA },
    }, (x) => {
      // 405 on HEAD means the host is alive and just dislikes the verb. Retrying with GET
      // rather than counting it dead — the first version of this cost me a false positive
      // on a live Stripe endpoint.
      if (x.statusCode === 405 && method === 'HEAD') { x.resume(); return res(req(url, 'GET')); }
      if (method === 'HEAD') { x.resume(); return res({ url, status: x.statusCode }); }
      const c = []; x.on('data', (d) => c.push(d));
      x.on('end', () => res({ url, status: x.statusCode, body: Buffer.concat(c).toString() }));
    });
    r.on('timeout', () => { r.destroy(); res({ url, status: 'TIMEOUT' }); });
    r.on('error', (e) => res({ url, status: e.code || 'ERR' }));
    r.end();
  });
}

async function pool(items, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (i < items.length) { const n = i++; out.push(await fn(items[n])); }
  }));
  return out;
}

// Pull every URL out of arbitrary JSON, whatever shape it is. Registries are shaped
// however the author felt that day; walking for strings that look like URLs survives all
// of them and needs no per-registry adapter.
function urlsIn(node, acc = new Set()) {
  if (typeof node === 'string') { if (/^https?:\/\//.test(node)) acc.add(node); return acc; }
  if (Array.isArray(node)) { node.forEach((n) => urlsIn(n, acc)); return acc; }
  if (node && typeof node === 'object') { Object.values(node).forEach((n) => urlsIn(n, acc)); return acc; }
  return acc;
}

function classify(results) {
  const dns = results.filter((r) => r.status === 'ENOTFOUND');
  const refused = results.filter((r) => ['ECONNREFUSED', 'MALFORMED', 'EAI_AGAIN'].includes(r.status));
  const tls = results.filter((r) => typeof r.status === 'string' && /CERT|TLS|SSL|ALTNAME/i.test(r.status));
  const gone = results.filter((r) => r.status === 404 || r.status === 410);
  const slow = results.filter((r) => r.status === 'TIMEOUT');
  const ok = results.filter((r) => typeof r.status === 'number' && r.status < 400);
  return { dns, refused, tls, gone, slow, ok };
}

function report(label, total, c) {
  console.log(`\n  ${label}`);
  console.log('  ' + '─'.repeat(58));
  console.log('  checked              ' + total);
  console.log('  answering (<400)     ' + c.ok.length);
  console.log('  host does not exist  ' + c.dns.length + '   <- DNS failure, unambiguous');
  console.log('  refused / malformed  ' + c.refused.length);
  console.log('  TLS broken           ' + c.tls.length);
  console.log('  404 / 410            ' + c.gone.length);
  console.log('  timed out            ' + c.slow.length + '   (slow, not conclusive)');
  const hard = c.dns.length + c.refused.length + c.tls.length;
  if (!hard && !c.gone.length) console.log('\n  ✓ clean. Say so — a null is a result.');
}

(async () => {
  const args = process.argv.slice(2);
  const mode = args.includes('--site') ? 'site' : 'json';
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) { console.error('usage: registry-audit.js [--json|--site] <url>'); process.exit(2); }

  if (mode === 'json') {
    const r = await req(target);
    let doc; try { doc = JSON.parse(r.body); } catch { console.error('not JSON:', r.status); process.exit(2); }
    const urls = [...urlsIn(doc)];
    console.log(`  ${urls.length} URLs found in ${target}`);
    const results = await pool(urls, (u) => req(u, 'HEAD'));
    const c = classify(results);
    report('REGISTRY', results.length, c);
    // GitHub 404s split into two very different claims, and conflating them is the whole
    // difference between a finding and a smear: a dead repo under a live org is ordinary
    // rot; a dead ORG means the row was never real.
    const gh = c.gone.filter((x) => /github\.com/.test(x.url));
    if (gh.length) {
      const orgs = [...new Set(gh.map((x) => (x.url.match(/github\.com\/([^/]+)/) || [])[1]).filter(Boolean))];
      // ⛔ MUST be the API, not the web page. github.com/<nonexistent> returns **200** — a
      // soft page — while api.github.com/users/<nonexistent> returns 404. The first version
      // of this checked the web URL, so it could never detect a ghost org: it reported the
      // fabricated `mcp` entries as "ordinary rot" while the headline counts (887/830/26)
      // came out exactly right, which is precisely why I nearly shipped it.
      // A control arm that reproduces the number but not the mechanism is not a control arm.
      const checked = await pool(orgs, async (o) => ({ o, ...(await req(`https://api.github.com/users/${o}`, 'HEAD')) }));
      const ghost = checked.filter((x) => x.status === 404).map((x) => x.o);
      if (ghost.length) {
        console.log('\n  ⛔ ORGS THAT DO NOT EXIST: ' + ghost.join(', '));
        console.log('     Entries under these were never real — not moved, not renamed.');
        ghost.forEach((o) => gh.filter((x) => x.url.includes(`github.com/${o}/`))
          .slice(0, 20).forEach((x) => console.log('       ' + x.url)));
      }
      const live = [...new Set(gh.map((x) => (x.url.match(/github\.com\/([^/]+)/) || [])[1]))].filter((o) => !ghost.includes(o));
      if (live.length) console.log('\n  ordinary rot (org exists, repo moved/renamed/private): ' + live.join(', '));
    }
  } else {
    const sm = await req(target.replace(/\/$/, '') + '/sitemap.xml');
    const pages = [...(sm.body || '').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    if (!pages.length) { console.error('no sitemap at ' + target + '/sitemap.xml'); process.exit(2); }
    console.log(`  ${pages.length} pages in sitemap`);
    const origin = new URL(target).origin;
    const targets = new Map();
    await pool(pages, async (p) => {
      const r = await req(p);
      for (const m of (r.body || '').matchAll(/href="(\/[^"#?]*)"/g)) {
        const t = origin + (m[1].replace(/\/$/, '') || '/');
        if (!targets.has(t)) targets.set(t, new Set());
        targets.get(t).add(p);
      }
      return null;
    });
    console.log(`  ${targets.size} distinct internal targets`);
    // ⛔ Zero extracted targets is a FAILED MEASUREMENT, not a clean result. The first
    // version printed "✓ clean" over it — on a JS-rendered site where the raw HTML carries
    // no hrefs at all, so the crawler saw nothing and reported the same as a crawler that
    // saw everything and found nothing wrong. That is the exact bug class this tool exists
    // to catch, shipped inside the tool. Say inconclusive and exit non-zero.
    if (targets.size === 0) {
      console.log('\n  ⚠ INCONCLUSIVE — extracted no links at all.');
      console.log('    The pages returned HTML with no href="/..." in it, which almost always');
      console.log('    means client-side rendering. This tool reads raw HTML and cannot see');
      console.log('    those links. It has NOT checked anything. Do not read this as clean.');
      process.exit(3);
    }
    const results = await pool([...targets.keys()], (u) => req(u, 'HEAD'));
    const c = classify(results);
    report('DOCS SITE', results.length, c);
    c.gone.slice(0, 25).forEach((b) => {
      console.log(`\n  ${b.status}  ${b.url}`);
      const from = [...targets.get(b.url)];
      console.log(`        linked from ${from.slice(0, 2).join(', ')}${from.length > 2 ? ` (+${from.length - 2})` : ''}`);
    });
  }
})();
