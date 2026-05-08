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
        core.hooks.tools.onView("file", fn, "summarized");
        core.hooks.tools.onView("repo", fn, "visible");
        core.hooks.tools.onView("repo", fn, "summarized");
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

### `core.hooks.tools.onView("file", fn, "summarized")`

Registers a view for file entries at summarized visibility. When a file
is summarized, the model sees its symbol tree (from `attributes.symbols`)
instead of the full content. Returns empty string if no symbols exist.

Handles both parsed and stringified attributes:

```js
(entry) => {
    const attrs = typeof entry.attributes === "string"
        ? JSON.parse(entry.attributes) : entry.attributes;
    return attrs?.symbols || "";
}
```

### `core.hooks.tools.onView("repo", fn, "visible" | "summarized")`

Registers projection views for the manifest entry at
`log://turn_0/repo/manifest`. The first argument matches Rummy core's
**action-segment dispatch** for log entries, not the URI scheme — see
§6 for the full convention. Both visibility levels are pass-through
(`(entry) => entry.body`); the manifest body is already model-ready
prose. `summarized` is registered defensively so the manifest survives
demotion without requiring a follow-up plugin change.

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
this turn? `visible` / `summarized` / `archived`. Governs model
attention and context-window cost only.

Visibility is NOT access. NOT existence. NOT membership. An
`archived` file is fully in the project, scannable, and retrievable
on demand via `<get>`. Membership constraints (`ignore`) and
visibility states (`archived`) are different mechanisms operating
on different axes; do not collapse them.

---

## 4. Visibility Model

Visibility governs the model's attention only — orthogonal to
membership (§3.1) and to access. An `archived` file is in the
project and retrievable on demand; it simply isn't pre-loaded into
the model's working context.

Files default to `"archived"` on first scan regardless of constraint
type. A 5000-file repo doesn't dump 400K tokens into context before any
work happens. The model orients via the `log://turn_0/repo/manifest` entry
(visible, written once per run) and promotes individual files to
`"summarized"` or `"visible"` as needed.

| Visibility | What the model sees |
|------------|-------------------|
| `"visible"` | Full file content |
| `"summarized"` | Symbol tree from `attributes.symbols` |
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

1. Load active runs and file constraints from the database
2. Include non-`ignore`-constrained files not in the git file list
3. Concurrently classify each member file (§5.3.1) and stat it; skip
   `ignore`-constrained files
4. For each file with changed mtime: apply the per-classification
   read rules (§5.3.1)
5. Skip if hash matches stored hash (mtime changed but content didn't)
6. If file existed before with different content, generate a diff via
   `hooks.hedberg.generatePatch` and write a `set://` entry
7. Extract symbols inline via antlrmap (ctags fallback queued) — for
   regular text entries only; skipped for symlink, submodule, and
   binary entries
8. Write to store via `store.set()` with `state: "resolved"`,
   visibility (preserve prior entry's visibility, else `"archived"`),
   classification attributes per §5.3.1, and `writer: "plugin"`
9. Batch ctags extraction for files antlrmap couldn't handle
10. Remove entries for files deleted from disk via `store.rm()`
11. On the first scan only, write `log://turn_0/repo/manifest` (turn 0,
    visible). Skipped on subsequent scans within the same run so the
    turn-0 prefix stays bit-identical for cache stability.

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

---

## 6. log://turn_0/repo/manifest

The model's orientation map. Written once per run at turn 0 with
`visibility: "visible"`. Body has two sections joined by a markdown
horizontal rule; the visibility apparatus selects which the model
sees.

**Content:**

```
* ./ - 2 files, 429 tokens
* src/ - 2 files, 1557 tokens

---

* package.json - 142 tokens
* README.md - 287 tokens
* src/index.js - 1024 tokens
* src/utils.js - 533 tokens
```

The first section is the **directory rollup**: one line per
directory that contains files, sorted alphabetically, with file
count and token sum. Files at the project root roll up under `./`.

The second section is the **comprehensive file list**: every file
with its individual token cost, sorted alphabetically by path
(locale-aware). Same shape as the per-file `* path - N tokens`
lines used elsewhere — paste-amenable for the model copying paths
into `<get>` / `<set>` calls.

**Two projections:**

- `visible` returns the whole body (rollup + flat list) so the
  model has both directory-level orientation and file-level
  pasteability in one render.
- `summarized` returns the rollup only — the part before the
  `\n\n---\n\n` delimiter. Same rollup that opens the visible
  projection, on its own.

When the visible body would push the dispatch packet over ceiling,
the budget plugin's standard demotion path flips the manifest to
`summarized`. The model still sees the directory map and can
recover the full list with `<get path="log://turn_0/repo/manifest"/>`
or scope its query with `<get path="src/**" manifest/>`. No bespoke
truncation; size adapts via the same FVSM mechanism as every other
oversized entry.

**Path shape and view dispatch.** The path is
`log://turn_N/<action>/<slug>` — Rummy's standard log-entry shape, where
`<action>` is the projection-dispatch key. Rummy core's
`materializeContext` extracts the action segment from log paths and
looks up views under that name rather than the literal `log` scheme,
so the plugin registers `core.hooks.tools.onView("repo", …)` to match.
We deliberately don't register a `repo://` scheme: it would compete
with the bare-path `file` scheme and attract accidental file-entry
writes. Every entry that reaches `materializeContext` must have a
visibility map registered for its projection key — `view()` throws on
missing keys — so `onView("repo", …)` is required for `visible` and
registered for `summarized` too as a defensive pass-through.

**Idempotence.** The manifest is written only if no entry already
exists at `log://turn_0/repo/manifest`. Subsequent scans within the same run
do not mutate it. This keeps the turn-0 prefix bit-identical for the
run's lifetime so the prefix cache holds clean across every subsequent
turn. A file added on turn 5 will appear in the per-file entries but
will not be retroactively listed in the manifest.

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
  FileScanner.js       File sync, inline symbol extraction, diff gen, log://turn_0/repo/manifest.
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
store/db and verify inline symbol extraction, state/visibility values,
constraint handling, `log://turn_0/repo/manifest` generation and idempotence
across re-scans, and `writer` attribution. GitProvider and ProjectContext
tests run against the real repo. Plugin tests verify the absence of any
`repo` scheme registration, the file-scheme summarized view handler,
guard clauses, and end-to-end scanning with symbol attachment via temp
git repos created with isomorphic-git.

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
