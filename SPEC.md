# rummy.repo: Architecture Specification

---

## 1. Plugin Contract

Implements the Rummy v2 plugin interface:

```js
export default class RummyRepo {
    #core;
    #scanner = null;

    constructor(core) {
        this.#core = core;
        core.on("turn.started", this.#onTurnStarted.bind(this));
        core.registerScheme({ name: "repo", category: "data", writableBy: ["plugin"] });
        core.hooks.tools.onView("file", fn);
        core.hooks.tools.onView("repo", fn);
    }
}
```

Loading: external plugins are declared via `RUMMY_PLUGIN_REPO=@possumtech/rummy.repo`
in the environment. The loader imports the package, instantiates the class,
and passes a `PluginContext` as the sole constructor argument.

The plugin stores `core` for access to `core.db`, `core.hooks`, and
`core.hooks.hedberg` (pattern matching and diff generation).

---

## 2. Registration

### `core.on("turn.started", fn)`

Fires every turn before context materialization. The plugin:

1. Checks `rummy.noRepo` -- skips if true
2. Checks `rummy.project.project_root` -- skips if absent
3. Lazily creates a FileScanner (once per plugin lifetime)
4. Opens a ProjectContext to enumerate git-tracked files
5. Runs `scanner.scan()` to sync file entries with inline symbol extraction

### `core.hooks.tools.onView("file", fn)`

Registers the file-scheme projection rendered as a catalog tile in
`<index>`. The view returns the symbol tree (from
`attributes.symbols`) when extraction succeeded, empty string
otherwise — `<index>` is a catalog, not a content dump; the model
retrieves full file bodies via `<get>`, which bypasses this hook.
Empty-tile-on-no-symbols is the budget-safety contract: falling
through to the raw body would dump every unsymbolic file into
`<index>` and blow the turn-1 budget.

Handles both parsed and stringified attributes:

```js
(entry) => {
    const attrs = typeof entry.attributes === "string"
        ? JSON.parse(entry.attributes) : entry.attributes;
    return attrs?.symbols ?? "";
}
```

### `core.hooks.tools.onView("repo", fn)`

Registers the repo-scheme projection for `repo://manifest`. The view
returns empty string — the manifest tile renders envelope-only in
`<index>`. The full inventory body is the compaction lifeline,
retrieved via `<get path="repo://manifest"/>`, which reads
`entry.body` directly and bypasses this hook. See §6.

`repo` is a registered scheme (`category: "data"`, `writableBy:
["plugin"]`), so model writes to `repo://` raise `PermissionError`
and strike.

---

## 3. Three Axes of Authority

The system has three orthogonal axes. Conflating them is the most
common source of bugs and the dominant pattern in rejected
contributions. Contributors MUST classify their work into exactly
one axis before writing code.

### 3.1 Membership

Is this file part of the project? Decided by `ProjectContext`.

**Authority:** `(git ls-files ∪ override-additions) − override-removals`.
This formula is the entire authority. No other input is permitted
to influence membership.

`override-additions` and `override-removals` come from the operator-
configured constraint table — `ignore`-visibility patterns subtract,
non-`ignore` patterns add. `ignore` constraints are load-bearing
security: they override git's "yes" with the operator's "no". This
is the only sanctioned subtractive override of git authority.

The codebase MUST NOT introduce any of the following in service of
membership decisions:

- bespoke filesystem walks
- exclusion lists (e.g. `EXCLUDED_DIRS`, `node_modules` carve-outs, build-output skips)
- dotfile rules
- symlink-skipping policies
- file-type heuristics
- project-type detection that gates membership

Non-git projects have no fs-walk fallback. Membership in non-git
mode is override-additions only. A non-git project with no `add`
constraints has zero members; this is correct behavior. The fix for
"my non-git project should be scannable" is to declare `add`
constraints, never to introduce a filesystem walk.

A regression test (§11) asserts these rules by static source
inspection, specifically to catch downstream attempts to reintroduce
repo-style schemes through narrow-looking patches.

### 3.2 Scanning

What does `FileScanner` do with a member file? Reads bytes,
classifies the entry (regular text / symlink / submodule / binary —
see §5.3.1), extracts symbols where applicable, writes a store entry.

Errors here MUST surface, not silently drop the file from
membership. A scan failure may leave a file's body empty with an
`attributes.error`, but the file remains a project member with a
manifest entry. Silent `return null` on a member file is forbidden:
membership is determined by §3.1 alone, and the scanner does not
get a veto over a file git tracks.

### 3.3 Visibility

Which projection of an already-stored entry does the model see
this turn? `indexed` / `visible` / `summarized` / `archived`.
Governs model attention and context-window cost only.

Visibility is NOT access. NOT existence. NOT membership. An
`indexed` or `archived` file is fully in the project, scannable,
and retrievable on demand via `<get>`. Membership constraints
(`ignore`) and visibility states are different mechanisms operating
on different axes; do not collapse them.

---

## 4. Visibility Model

Visibility governs the model's attention only — orthogonal to
membership (§3.1) and to access. An `indexed` or `archived` file is
in the project and retrievable on demand; the visibility level
controls how (or whether) it appears in the rendered context.

Files default to `"indexed"` on first scan regardless of constraint
type. Each file becomes a symbol-bearing tile in `<index>` — compact
catalog entries, not full bodies. A 5000-file repo renders a list of
envelopes, not 400K tokens of source. The model orients via the
`<index>` tiles plus the `repo://manifest` directory rollup (also
`indexed`), and promotes individual files to `"summarized"` or
`"visible"` as needed.

| Visibility | What the model sees |
|------------|-------------------|
| `"visible"` | Full file content |
| `"summarized"` | Symbol tree from `attributes.symbols` |
| `"indexed"` | Catalog tile in `<index>` — symbols (file) or empty envelope (`repo://manifest`) |
| `"archived"` | Nothing (retrievable via `<get>`) |

The model controls promotion/demotion via `<set visibility="..."/>`.
The plugin preserves prior visibility on re-scan so the model's own
changes aren't clobbered. Constraint type governs membership (`add`,
`readonly`) and write permission (`readonly`); it does not force an
initial visibility.

---

## 5. File Scanning Pipeline

Membership authority is defined in §3.1. This section covers how
member files are read, classified, and written into the store.

### 5.1 ProjectContext

Resolves membership per §3.1. `ProjectContext` does NOT read the
filesystem; it composes git's tracked-file list with the operator's
explicit additions.

```
ProjectContext.open(projectRoot, dbFiles?)
  -> GitProvider.detectRoot()
  -> if git: GitProvider.getHeadHash()      // cache key
            GitProvider.getTrackedFiles()   // Set<string>
            scope-filter to files under project root
            union with dbFiles
  -> if non-git: dbFiles only (no fs-walk)
```

The scope-filter is not an exclusion: it is the answer to "you
opened a subdirectory of a larger repo; show me files in that
subdirectory." Files outside the scope still belong to the repo,
they simply weren't asked about.

Results are cached by HEAD hash in git mode. A new commit
invalidates the cache. Non-git mode is not cached.

### 5.2 GitProvider

CLI `git` first, with isomorphic-git (optional dependency) as fallback
when git is not installed. CLI availability is checked once at module
load. isomorphic-git is lazy-loaded only if needed.

| Method | Purpose |
|--------|---------|
| `detectRoot(path)` | Find `.git` root from any path |
| `getTrackedFiles(root)` | All files tracked by HEAD |
| `getHeadHash(root)` | Current HEAD commit hash |
| `isIgnored(root, path)` | Check `.gitignore` |

### 5.3 FileScanner

Syncs the filesystem into the known store for all active runs. Symbols
are extracted inline during the scan.

**Per-scan flow:**

1. Load active runs, file constraints, and the current loop from the
   database
2. Include non-`ignore`-constrained files not in the git file list
3. Concurrently classify each member file (§5.3.1) and stat it; skip
   `ignore`-constrained files
4. For each file with changed mtime: apply the per-classification
   read rules (§5.3.1)
5. Skip if hash matches stored hash (mtime changed but content didn't)
6. If the run has prior file entries (not the bootstrap scan) and the
   file body changed, synthesize an action-log entry at
   `log://<L>/<T>/<S>/set` with body in the model's SEARCH/REPLACE
   edit grammar (via `hooks.hedberg.generateSearchReplaceBody`).
   `attributes.patch` carries the udiff for client renderers;
   `attributes.external = true` flags engine authorship. See §5.3.2.
7. Extract symbols inline via antlrmap (ctags fallback queued) — for
   regular text entries only; skipped for symlink, submodule, and
   binary entries
8. Write to store via `store.set()` with `state: "resolved"`,
   visibility (preserve prior entry's visibility, else `"indexed"`),
   classification attributes per §5.3.1, `loopId` from the active
   loop, and `writer: "plugin"`
9. Batch ctags extraction for files antlrmap couldn't handle
10. For each entry whose file disappeared from disk, synthesize a
    `log://<L>/<T>/<S>/rm` action-log entry (`attributes.external =
    true`, empty body) and then remove the file entry via
    `store.rm()`. See §5.3.2.
11. Write `repo://manifest` (visibility `indexed`) with the current
    file inventory. Refreshed every scan so files added or removed
    mid-run become visible to the model on the next loop. Requires
    an active loop; if no loop has dispatched yet, the manifest
    write is deferred to the next scan and file entries carry the
    freshest state in the meantime.

**Constraint matching** uses `hooks.hedberg.match` for pattern-based
constraints (glob, regex, etc.) rather than exact string equality.

**Store operations** use the v2 `store.set()` / `store.rm()` API with
named arguments and `writer: "plugin"` attribution.

#### 5.3.1 Entry Classification

Every member file is classified into exactly one of four types. The
classification determines body content and `attributes` shape.
Membership is identical across all four classifications — every
classified entry appears in the manifest.

| Classification | Detection | Body | Key attribute |
|----------------|-----------|------|---------------|
| Regular text | `lstat` regular file; first 8KB has no `\0` byte | UTF-8 file content | `symbols` (if extracted) |
| Symlink | `lstat` symbolic link | `readlink` result (target string) | `symlink: "<target>"` |
| Binary | `lstat` regular file; first 8KB contains `\0` byte | empty | `binary: true` |

Anything that doesn't match these three cases — submodule gitlinks
(mode 160000), `EISDIR`, `ELOOP`, `EACCES`, FIFOs, sockets, device
nodes, any other condition — falls into the **error catch-all**:
empty body, `attributes.error = "<code-or-reason>"`, the file
remains a member of the manifest. Silent drops are forbidden
(§3.2); honest "this is here, this is what went wrong" entries are
required.

**Detection MUST match git literally:**

- Symlink detection uses `lstat`, never `stat`. `stat` follows
  symlinks and reports the target's type, which answers the wrong
  question and silently drops link-to-dir and link-to-broken cases.
- Binary detection scans the first 8KB for a `\0` byte. This is
  git's own heuristic (used by `git diff` / `git log -p`); aligning
  with it prevents classification drift.

**Rationale for storing literal git content (not dereferenced):**

- *Symlinks store the link string, not the target's bytes.*
  Following the link would (a) bypass `ignore` constraints when
  the target path is constrained but the link path is not, (b)
  import bytes outside git's authority when the target lives
  outside the repo, (c) collide entry-path identity (the path is
  `lib/foo`, the bytes belong to `shared/foo`), and (d) reintroduce
  the EACCES/ELOOP crash surface the membership layer specifically
  excludes. If the target is itself tracked, the model has it as
  its own manifest entry; if not, it is intentionally not in the
  project.
- *Binaries store no body.* Symbols and diffs are meaningless on
  binary data, and UTF-8-decoding non-text bytes wastes context
  tokens on garbage. The file remains a project member (manifest
  entry, retrievable). If the model needs the bytes, it bypasses
  the plugin via `<env/>`.

**Errors during classification or read MUST surface as attributes**
on the entry, not as silent drops. Membership is decided in §3.1
alone; the scanner does not get a veto.

**Submodules deferred.** Submodule gitlinks (mode 160000) currently
land in the catch-all with `attributes.error = "submodule"`. When
real demand appears, submodules can be promoted to a fourth
classification with SHA-as-body and `attributes.submodule`,
mirroring `git show HEAD:<path>` output. Promotion requires
extending `GitProvider` to surface ls-files mode metadata; that
work is gated on demand, not specified preemptively. The catch-all
shape is forward-compatible: a submodule entry already exists in
the manifest (just with an error attribute), so promoting it later
is a body/attribute swap, not a membership change.

#### 5.3.2 External Mutation Injection

The model is the authoritative writer of file content, but the
filesystem is a shared surface — an operator's editor, a build
script, or a sibling process can mutate files between turns. When
the scanner detects a mutation that didn't come from the model, it
synthesizes a log entry so the change appears in the model's own
edit grammar instead of materializing as silent state drift.

**Path shape.** `log://<L>/<T>/<S>/<action>` where `<action>` is
`set` for create/modify and `rm` for delete. Sequence numbers (`<S>`)
are issued by `store.logPath()`.

**Body shape.**

- `set`: SEARCH/REPLACE block via
  `hooks.hedberg.generateSearchReplaceBody(before, after)`. For a
  first-appearance file (no prior entry body), SEARCH is empty and
  REPLACE carries the full content; for a modification, one
  SEARCH/REPLACE pair per diff hunk.
- `rm`: empty body.

**Attributes.**

- `path`: project-relative file path.
- `external: true`: distinguishes engine-injected mutations from
  model-authored ones.
- `patch` (set only, optional): udiff string from
  `hooks.hedberg.generatePatch`, for client renderers (e.g.
  rummy.nvim) that prefer unified-diff display.

**Bootstrap guard.** When the run has zero prior file entries
(`existing.length === 0`), the entire scan is the project baseline,
not a delta. Injecting one log entry per file would dump the whole
project into `<log>` on turn 1. Bootstrap skips injection; file
entries themselves carry the baseline state. Subsequent scans inject
for real deltas.

**Loop guard.** Log paths require a `loopId`. If the run hasn't
dispatched its first turn yet (no active loop), injection is skipped.
File entries still write — only the log surfacing is deferred.

**Rendering ownership.** `set` and `rm` action-log entries are
rendered by Rummy core's central entry renderer, not by this plugin.
The plugin produces the body content; core wraps it in the standard
recap envelope. This plugin registers no view hook for either action.

---

## 6. repo://manifest

The model's orientation map. A single entry at the plugin-owned
`repo://` scheme (registered in §1), written by the scanner and
refreshed every scan with `visibility: "indexed"`. The body is the
comprehensive file inventory; the `<index>` tile renders empty
(envelope-only) — the inventory is retrieved on demand via
`<get path="repo://manifest"/>`, which bypasses the view hook and
reads `entry.body` directly. This is the compaction lifeline when
the indexed file-tile set itself overshoots ceiling.

**Body shape.** Canonical JSON-per-row. Rollup rows first (path ends
with `/`), per-file rows after. One list, one format, no separator.

```
{"path":"./","tokens":429}
{"path":"src/","tokens":1557}
{"path":"package.json","tokens":142,"lines":18}
{"path":"README.md","tokens":287,"lines":42}
{"path":"src/index.js","tokens":1024,"lines":120}
{"path":"src/utils.js","tokens":533,"lines":67}
```

Rollup rows aggregate `tokens` per directory; root files roll up
under `"./"`. Per-file rows carry `tokens` and `lines` (file body
line count) so the model can plan partial reads —
`<get path="src/index.js" lineFirst=… lineFinal=…/>` — without
computing the denominator. `lines` is omitted on empty bodies
(symlinks, binaries, error catch-all).

**Refresh semantics.** The manifest is rewritten on every scan with
the current inventory. Files added or removed mid-run appear on the
next scan's manifest. This is a deliberate departure from the
pre-loopId design, where the manifest was a turn-0 snapshot held
bit-identical for prefix-cache stability — under loop-scoped entries,
the manifest's job is current orientation, not cache substrate.

**Loop requirement.** The manifest entry carries a `loopId` (schema
`NOT NULL`). When the run hasn't dispatched its first loop yet, the
scan skips the manifest write; file entries themselves carry the
freshest state until the next scan inside an active loop.

**Scheme ownership.** `repo` is registered at plugin construction as
`category: "data"`, `writableBy: ["plugin"]`. Model writes to
`repo://` raise `PermissionError` and strike — the manifest is
engine-maintained orientation, not a model-editable surface.

**View hook.** `core.hooks.tools.onView("repo", () => "")` — single
projection returning empty string. The `<index>` tile shows only the
envelope (path + token count); the body is reached only via explicit
`<get>`. Rummy core's `materializeContext` also dispatches log
entries by their action segment, so the same `repo` view name would
catch any `log://<L>/<T>/<S>/repo` action entries — but this plugin
doesn't synthesize any such entries (Phase 3 injections use `set` /
`rm`, see §5.3.2), so the action-segment overlap is presently moot.

---

## 7. Symbol Extraction

Symbols are extracted inline during the file scan. Each file write
carries its `attributes.symbols` if extraction succeeded.

### 7.1 Antlrmap (Primary)

A single `Antlrmap` instance is created when the FileScanner is
constructed and reused across all scans. For each changed file with a
supported extension, `antlrmap.mapSource(content, ext)` is called. If
symbols are returned, they are formatted and attached to the write.

### 7.2 Ctags (Fallback)

Files where antlrmap returns no symbols or has no grammar are queued
for a single batched `ctags --output-format=json --fields=+nS`
invocation. Results are written back as attribute-only updates via
`store.set()`.

**Lua workaround**: ctags does not provide function signatures for Lua.
`CtagsExtractor` extracts them from the ctags `pattern` field.

---

## 8. Symbol Data Structure

Antlrmap symbols:

```js
{
    name: "functionName",       // required
    kind: "function",           // function, class, method, field, interface, enum
    params: ["a", "b"],         // array or string; optional
    line: 42,                   // 1-based line number; optional
    endLine: 50                 // used for nesting; optional
}
```

Ctags symbols:

```js
{
    name: "functionName",
    type: "function",           // "type" not "kind" (ctags convention)
    params: "(a, b)",           // string (signature); optional
    line: 42,
    source: "standard"
}
```

---

## 9. formatSymbols

Converts symbol arrays to indented text trees.

### Algorithm

1. Sort symbols by `line` (ascending, `0` for missing)
2. Maintain a stack of "open" parent symbols (those with `endLine`)
3. For each symbol:
   - Pop parents whose `endLine` has been passed
   - Indent by stack depth (2 spaces per level)
   - Format as `{indent}{kind} {name}({params}) L{line}`
   - Push onto stack if it has a valid `endLine` range

### Output

```
class MyClass L1
  method doThing(a, b) L5
  field name L3
class AnotherClass L25
```

---

## 10. Module Structure

```
src/
  rummy.repo.js        Plugin entry. View handlers, turn.started listener.
  FileScanner.js       File sync, inline symbol extraction, external-mutation log injection, repo://manifest.
  ProjectContext.js     Git-aware file enumeration. Caches by HEAD hash.
  GitProvider.js        CLI git first, isomorphic-git fallback. Lazy loaded.
  CtagsExtractor.js    Universal Ctags wrapper. Synchronous child process.
  formatSymbols.js      Symbol array -> indented text tree.
```

---

## 11. Testing

| Tier | Location | Coverage |
|------|----------|----------|
| Unit | `src/*.test.js` | 80% line/branch/function threshold |

Tests use Node's built-in test runner (`node:test`) and assertion module
(`node:assert/strict`). FileScanner tests use temp directories with mock
store/db and verify inline symbol extraction, state/visibility values
(default `indexed`), constraint handling, `repo://manifest` generation
and refresh across re-scans, Phase 3 external-mutation log injection
(`set` with SEARCH/REPLACE bodies and `rm` with empty bodies, both
carrying `attributes.external = true`), bootstrap-skip semantics,
loop-id guarding, and `writer` attribution. GitProvider and
ProjectContext tests run against the real repo. Plugin tests verify
presence of the `repo` scheme registration, the single-projection
`file` and `repo` view handlers, guard clauses, and end-to-end
scanning with symbol attachment via temp git repos created with
isomorphic-git.

**Architecture regression tests** (`src/architecture.test.js`) assert
the membership-axis rules from §3.1 as positive structural
invariants. They exist specifically to catch downstream attempts to
reintroduce repo-style schemes through narrow-looking patches:

- `ProjectContext.js` imports only from an allowlist (`node:path`,
  `./GitProvider.js`). Any attempt to read the filesystem, shell
  out, or pull in external discovery libraries fails the test.
  This single positive invariant covers the entire deny-list in
  §3.1 by construction — surface-keyword grep tests give false
  confidence and are not used.
- `ProjectContext.open` accepts only `(path, dbFiles?)`. New
  parameters that could influence membership require a deliberate
  signature change, surfacing the design decision in code review.

Symlink classification, binary detection, and `lstat` use are
permitted in `FileScanner` (axis 2 — scanning) but forbidden in
`ProjectContext` (axis 1 — membership).

```bash
npm test              # lint + unit tests with coverage
npm run test:unit     # unit tests only
npm run lint          # biome check
```
