#!/usr/bin/env node
// whereruns-mcp — the check, placed inside the loop where the mistake actually happens.
//
// The CLI is the wrong shape for the primary customer. An agent about to reason about a
// file does not shell out and read stdout; it calls a tool. So the same check gets a
// second front door, and both call inspect() — one implementation, because the day they
// diverge is the day the human and the agent get different answers and neither notices.
//
//   claude mcp add whereruns -- node /path/to/mcp.js
//
// Zero dependencies, stdio JSON-RPC. Add it to an agent and the question
// "are these the bytes that execute?" becomes one call instead of a discipline.
'use strict';
const { inspect } = require('./whereruns.js');

const TOOL = {
  name: 'whereruns',
  description:
    'Before reasoning about or editing a source file, check WHERE IT ACTUALLY EXECUTES. ' +
    'Finds same-named copies across likely deploy roots, hashes them, and reports drift. ' +
    'Call this on any file you are about to analyse or change when a deployed/staged copy ' +
    'might exist. Answers: am I reading the bytes that run?',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File to check.' },
      roots: {
        type: 'array', items: { type: 'string' },
        description: 'Optional roots to search. Defaults to sensible deploy locations.',
      },
    },
    required: ['path'],
  },
};

// The summary is written for a reader who will act on it, so the verdict comes FIRST and
// in words, not as a field to be interpreted. An agent that has to derive "this is bad"
// from a boolean three keys deep will sometimes not derive it.
function summarise(r) {
  if (!r.ok) return `whereruns: ${r.why}`;
  const lines = [];
  if (r.drifted.length) {
    lines.push(`⛔ DRIFT — the file you are reading is NOT what runs in ${r.drifted.length} location(s).`);
    for (const c of r.drifted) {
      lines.push(`   ${c.path}`);
      lines.push(`     ${c.bytes} bytes vs your ${r.bytes}` +
        (Number.isFinite(c.ageDays) ? `, ${Math.abs(c.ageDays)} day(s) ${c.ageDays > 0 ? 'older' : 'newer'}` : ''));
    }
    lines.push('   Reason about the executing copy, or stage your change before trusting either.');
  } else if (r.copies.length) {
    lines.push(`✓ ${r.copies.length} other cop(ies) found and all are byte-identical.`);
  } else {
    lines.push('✓ No other copies found in the searched roots.');
  }
  // Unreachable roots are reported LOUDLY and never swallowed. The tool's own first run
  // printed "all copies identical" while silently skipping the one root that held the
  // drifted file — a check that fails quiet manufactures confidence, which is strictly
  // worse than not running it.
  if (r.unreachable && r.unreachable.length) {
    lines.push(`⚠ Could not read: ${r.unreachable.join(', ')} — this result is INCOMPLETE.`);
  }
  lines.push(`   searched: ${r.roots.join(', ')}`);
  return lines.join('\n');
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function fail(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return respond(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'whereruns', version: '1.0.0' },
    });
  }
  if (method === 'tools/list') return respond(id, { tools: [TOOL] });
  if (method === 'tools/call') {
    const a = (params && params.arguments) || {};
    if (!a.path) return fail(id, -32602, 'path is required');
    let r;
    try { r = inspect(a.path, a.roots); } catch (e) { return fail(id, -32603, String(e.message || e)); }
    return respond(id, {
      // isError on drift so an agent that only checks the flag still stops. The text is
      // for the one that reads, the flag is for the one that doesn't.
      isError: !!(r.ok && r.drifted.length),
      content: [{ type: 'text', text: summarise(r) }],
    });
  }
  // Notifications have no id and must not be answered at all.
  if (id !== undefined && id !== null) fail(id, -32601, `unknown method: ${method}`);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  // Line-delimited. A partial line is kept rather than parsed — a JSON-RPC frame split
  // across two reads is normal, not an error, and treating it as one drops real calls.
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch { /* unparseable frame — ignore, do not crash the server */ }
  }
});
process.stdin.on('end', () => process.exit(0));
