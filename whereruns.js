#!/usr/bin/env node
// whereruns — answer the reader's question, not the writer's.
//
//   "I am about to reason about this file. Where does it actually EXECUTE,
//    and are those the same bytes?"
//
// Every existing tool is writer-side: IaC drift asks does the cloud match my config,
// attestation asks did the pipeline build what it claims. Both protect the deploy.
// Nothing protects the person — or the agent — about to read a file and act on it.
//
// It was never needed before because the reader of a file was almost always the
// person who deployed it, and carried the map in their head. That stopped being true.
//
//   whereruns src/thing.js
//   whereruns src/thing.js --roots /srv,/opt,N:/live
//   whereruns src/thing.js --json
//
// Exits 1 on drift, so it works as a CI gate and as an agent precondition.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const MAX_DEPTH = 6;
const SKIP = new Set(['node_modules', '.git', '.svn', 'vendor', '__pycache__', '.venv',
  'dist-cache', '.cache', 'Windows', '$Recycle.Bin', 'System Volume Information']);

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Walk for same-named files. Bounded depth and a skip list, because the whole point is
// a check cheap enough that people actually run it — a scan that takes four minutes is
// a scan that gets skipped, and a skipped check is worth exactly nothing.
// `/n/foo` is a perfectly good path to a shell and means nothing to Node — from a D:
// cwd it resolves to D:\n\foo. This bit me inside the tool built to catch exactly this
// class of mistake, which is either funny or the whole thesis.
function normalizeRoot(r) {
  if (process.platform !== 'win32') return r;
  const m = /^[\\/]([a-zA-Z])[\\/](.*)$/.exec(r);
  return m ? `${m[1].toUpperCase()}:\\${m[2]}` : r;
}

function findByName(roots, basename, self, unreachable) {
  const hits = [];
  const seen = new Set();
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (e.name !== basename) continue;
      const real = path.resolve(full);
      if (real === self || seen.has(real)) continue;
      seen.add(real);
      hits.push(real);
    }
  };
  // A root that cannot be read is REPORTED, never silently dropped. Skipping in silence
  // is how this tool told me "all copies identical" while walking past the very file
  // that started it: two roots went in, one was unreachable, and nothing said so. A
  // check that fails quiet is worse than no check, because it manufactures confidence.
  for (const r of roots) {
    const full = path.resolve(normalizeRoot(r));
    try {
      if (fs.statSync(full).isDirectory()) walk(full, 0);
      else unreachable.push({ root: r, why: 'not a directory' });
    } catch (e) {
      unreachable.push({ root: r, resolved: full, why: e.code || 'unreadable' });
    }
  }
  return hits;
}

// Roots worth looking in when nobody said. Deliberately conservative: guessing wide
// makes this slow, and slow makes it optional.
function defaultRoots(target) {
  const out = new Set();
  let dir = path.dirname(path.resolve(target));
  for (let i = 0; i < 3 && dir !== path.dirname(dir); i++) { out.add(dir); dir = path.dirname(dir); }
  for (const p of ['/srv', '/opt', '/var/www', '/usr/local/share',
    path.join(os.homedir(), 'apps'), path.join(os.homedir(), 'deploy')]) {
    try { if (fs.statSync(p).isDirectory()) out.add(p); } catch { /* absent */ }
  }
  // Windows: other local drives are where a staged copy usually hides.
  if (process.platform === 'win32') {
    for (const l of 'CDEFGHNPSTUVWXYZ') {
      const root = `${l}:\\`;
      try { if (fs.statSync(root).isDirectory()) out.add(root); } catch { /* no drive */ }
    }
  }
  return [...out];
}

function human(n) {
  return n.toLocaleString('en-US');
}

// The whole check, with no I/O of its own. The CLI prints it and the MCP server returns
// it — one implementation behind two front doors, because the day they diverge is the day
// the agent gets a different answer than the human and neither of them finds out.
function inspect(target, rootsArg) {
  const unreachable = [];
  const self = path.resolve(normalizeRoot(target));
  if (!fs.existsSync(self)) return { ok: false, why: `no such file: ${target}` };

  const roots = rootsArg && rootsArg.length ? rootsArg : defaultRoots(target);
  const selfStat = fs.statSync(self);
  const selfHash = sha(self);
  const copies = findByName(roots, path.basename(self), self, unreachable).map((p) => {
    const st = fs.statSync(p);
    let h = null;
    try { h = sha(p); } catch { /* unreadable */ }
    return {
      path: p,
      bytes: st.size,
      mtime: st.mtime,
      sha: h,
      identical: h === selfHash,
      ageDays: Math.round((selfStat.mtime - st.mtime) / 86400000),
    };
  });
  return {
    ok: true,
    target: self,
    sha: selfHash,
    bytes: selfStat.size,
    mtime: selfStat.mtime,
    roots,
    copies,
    drifted: copies.filter((c) => !c.identical),
    unreachable,
  };
}

function main() {
  const args = process.argv.slice(2);
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) {
    console.error('usage: whereruns <path> [--roots a,b] [--json] [--quiet]');
    process.exit(2);
  }
  const asJson = args.includes('--json');
  const quiet = args.includes('--quiet');
  const ri = args.indexOf('--roots');

  const r = inspect(target, ri !== -1 && args[ri + 1] ? args[ri + 1].split(',') : null);
  if (!r.ok) { console.error(`⛔ ${r.why}`); process.exit(2); }
  const { self, selfStat, selfHash, copies, unreachable } = {
    self: r.target, selfStat: { mtime: r.mtime, size: r.bytes }, selfHash: r.sha,
    copies: r.copies, unreachable: r.unreachable,
  };
  const roots = r.roots;

  const drifted = copies.filter((c) => !c.identical);

  if (asJson) {
    console.log(JSON.stringify({ target: self, sha: selfHash, bytes: selfStat.size, copies }, null, 2));
    process.exit(drifted.length ? 1 : 0);
  }

  if (!quiet) {
    console.log(`\n  reading   ${self}`);
    console.log(`            ${human(selfStat.size)} bytes · ${selfHash.slice(0, 12)}\n`);
    if (unreachable.length) {
      console.log('  ⚠ roots that could NOT be searched — results below are incomplete:');
      for (const u of unreachable) {
        console.log(`      ${u.root}${u.resolved && u.resolved !== u.root ? `  ->  ${u.resolved}` : ''}  (${u.why})`);
      }
      console.log('');
    }
    if (!copies.length) {
      console.log('  no other copies found in the searched roots.');
      console.log('  ⚠ that is NOT proof it runs from here — it is proof this search did not find another.');
      console.log(`     searched: ${roots.join(', ')}\n`);
    }
    for (const c of copies) {
      const flag = c.identical ? '  ok  ' : ' DRIFT';
      console.log(`  ${flag}    ${c.path}`);
      console.log(`            ${human(c.bytes)} bytes · ${c.sha ? c.sha.slice(0, 12) : 'unreadable'}` +
        (c.identical ? '' : `  ⚠ ${c.ageDays > 0 ? c.ageDays + ' days older' : 'differs'}`));
    }
    if (drifted.length) {
      console.log(`\n  ⛔ ${drifted.length} cop${drifted.length === 1 ? 'y' : 'ies'} on disk differ${drifted.length === 1 ? 's' : ''} from what you are reading.`);
      console.log('     Find out which one executes before you reason about this file.\n');
    } else if (copies.length) {
      console.log('\n  all copies identical.\n');
    }
  }
  process.exit(drifted.length ? 1 : 0);
}

// Only run as a CLI. Without this guard, `require('./whereruns.js')` executes main(),
// which prints usage and exits — so the MCP server died on import, silently, before it
// could answer a single call. A module that does something on import is a module that
// cannot be reused, and reuse was the entire point of splitting inspect() out.
if (require.main === module) main();

module.exports = { inspect, defaultRoots, normalizeRoot };
