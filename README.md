# whereruns

**Before you reason about a file, find out where it actually executes.**

```
npx whereruns src/handler.js
```

No dependencies. One file. Exits non-zero on drift, so it works as a CI gate or as a
precondition an agent can call before it starts thinking.

---

## The question

> *I am about to reason about this file. Where does it actually execute — and are those
> the same bytes?*

Nothing answers this. Everything adjacent is **writer-side**:

| tool | question it answers |
|---|---|
| Terraform / Pulumi drift | does the deployed environment match my configuration? |
| SLSA, sigstore, in-toto | did the pipeline build what it claims? |
| source maps | which source produced this bundle? |

All three protect **the deploy**. None protect the person — or the agent — about to read a
file and act on what it says.

## Why it didn't need to exist before

For most of software history the person reading a file was the person who deployed it.
They carried the map in their head: *that's the working copy, the live one is on the other
box.* The knowledge lived in ambient human context, so a tool would have solved a problem
nobody had.

That changed. A large share of code reading is now done by agents, which have no ambient
deployment context, no memory of the staging step someone did on Tuesday, high confidence,
and a tendency to **act** immediately rather than squint.

A silent wrong-file failure used to cost an engineer an afternoon. It now costs a
production change made against source that was never running.

## What it does

Hashes the file you point at, finds same-named copies across candidate roots, and tells you
which of them differ.

```
  reading   /home/me/app/handler.js
            18,442 bytes · 9c1e77ab40f2

  ⚠ roots that could NOT be searched — results below are incomplete:
      /mnt/deploy  ->  /mnt/deploy  (ENOENT)

    ok      /srv/app/handler.js
            18,442 bytes · 9c1e77ab40f2
   DRIFT    /opt/legacy/app/handler.js
            7,110 bytes · 48535f8e23cc  ⚠ 18 days older

  ⛔ 1 copy on disk differs from what you are reading.
     Find out which one executes before you reason about this file.
```

```
whereruns <path>                    search sensible default roots
whereruns <path> --roots /srv,/opt  search these instead
whereruns <path> --json             machine-readable, for agents and CI
```

## It lied to me on its first run, and that's the design note

I pointed it at the case that motivated it: one canonical file, two candidate install
roots, one of which held a stale copy. It printed a confident **`all copies identical`** —
having walked straight past the file it exists to find.

One of the two roots was written in a form the runtime resolved differently, so it silently
became a directory that didn't exist. The code did `try { stat } catch { /* unreadable */ }`
and **moved on without a word.** One root became zero, one copy became the only copy, and
the tool reported unanimity across a set of one.

The path form was the trigger. **The defect was the silence.** A check that skips quietly
doesn't merely fail to help — it manufactures confidence, which is strictly worse than not
running it at all.

So unreachable roots are now loud, and they're listed *above* the results, because a partial
answer presented as a complete one is the failure this tool exists to prevent.

## Limits, plainly

- It finds copies **by filename** across roots you give it or a conservative default set. It
  does not introspect running processes, container layers, or bundles yet.
- **No copies found is not proof the file runs from here.** It's proof this search didn't
  find another one, and the output says exactly that.
- Bounded walk depth and a skip list, deliberately: a scan that takes four minutes is a scan
  that gets skipped, and a skipped check is worth nothing.

## Install

```
npx whereruns <path>
# or
curl -O https://raw.githubusercontent.com/siliroid/whereruns/main/whereruns.js
node whereruns.js <path>
```

MIT.
