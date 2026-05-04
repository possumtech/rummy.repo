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

---

## 3. Visibility Model

Files default to `"archived"` on first scan regardless of constraint
type. A 5000-file repo doesn't dump 400K tokens into context before any
work happens. The model orients via the `log://turn_0/manifest` entry
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

## 4. File Scanning Pipeline

### 4.1 ProjectContext

Enumerates project files by combining git-tracked files with
database-stored file constraints.

```
ProjectContext.open(projectRoot, dbFiles?)
  -> GitProvider.detectRoot()
  -> GitProvider.getHeadHash()      // cache key
  -> GitProvider.getTrackedFiles()  // Set<string>
  -> filter to files under project root
  -> merge with dbFiles
```

Results are cached by HEAD hash. A new commit invalidates the cache.

### 4.2 GitProvider

CLI `git` first, with isomorphic-git (optional dependency) as fallback
when git is not installed. CLI availability is checked once at module
load. isomorphic-git is lazy-loaded only if needed.

| Method | Purpose |
|--------|---------|
| `detectRoot(path)` | Find `.git` root from any path |
| `getTrackedFiles(root)` | All files tracked by HEAD |
| `getHeadHash(root)` | Current HEAD commit hash |
| `isIgnored(root, path)` | Check `.gitignore` |

### 4.3 FileScanner

Syncs the filesystem into the known store for all active runs. Symbols
are extracted inline during the scan.

**Per-scan flow:**

1. Load active runs and file constraints from the database
2. Include non-`ignore`-constrained files not in the git file list
3. Stat all files concurrently (no content reads), skip `ignore`-constrained
4. For each file with changed mtime: read content, compute SHA-256 hash
5. Skip if hash matches stored hash (mtime changed but content didn't)
6. If file existed before with different content, generate a diff via
   `hooks.hedberg.generatePatch` and write a `set://` entry
7. Extract symbols inline via antlrmap (ctags fallback queued)
8. Write to store via `store.set()` with `state: "resolved"`,
   visibility (preserve prior entry's visibility, else `"archived"`),
   and `writer: "plugin"`
9. Batch ctags extraction for files antlrmap couldn't handle
10. Remove entries for files deleted from disk via `store.rm()`
11. On the first scan only, write `log://turn_0/manifest` (turn 0,
    visible). Skipped on subsequent scans within the same run so the
    turn-0 prefix stays bit-identical for cache stability.

**Constraint matching** uses `hooks.hedberg.match` for pattern-based
constraints (glob, regex, etc.) rather than exact string equality.

**Store operations** use the v2 `store.set()` / `store.rm()` API with
named arguments and `writer: "plugin"` attribution.

---

## 5. log://turn_0/manifest

A flat list of every project file with its token cost, written once per
run at turn 0 with `visibility: "visible"`. Acts as the model's
orientation map without dumping file contents.

**Content:**

```
* package.json - 142 tokens
* README.md - 287 tokens
* src/index.js - 1024 tokens
* src/utils.js - 533 tokens
...
```

Lines are alphabetical by path (locale-aware). Each line shows the path
and its token cost so the model can budget which files to promote to
`"summarized"` or `"visible"`. There are no headers, directory rollups,
constraint listings, navigation legend, or absolute paths — just the
file list.

**Idempotence.** The manifest is written only if no entry already
exists at `log://turn_0/manifest`. Subsequent scans within the same run
do not mutate it. This keeps the turn-0 prefix bit-identical for the
run's lifetime so the prefix cache holds clean across every subsequent
turn. A file added on turn 5 will appear in the per-file entries but
will not be retroactively listed in the manifest.

---

## 6. Symbol Extraction

Symbols are extracted inline during the file scan. Each file write
carries its `attributes.symbols` if extraction succeeded.

### 6.1 Antlrmap (Primary)

A single `Antlrmap` instance is created when the FileScanner is
constructed and reused across all scans. For each changed file with a
supported extension, `antlrmap.mapSource(content, ext)` is called. If
symbols are returned, they are formatted and attached to the write.

### 6.2 Ctags (Fallback)

Files where antlrmap returns no symbols or has no grammar are queued
for a single batched `ctags --output-format=json --fields=+nS`
invocation. Results are written back as attribute-only updates via
`store.set()`.

**Lua workaround**: ctags does not provide function signatures for Lua.
`CtagsExtractor` extracts them from the ctags `pattern` field.

---

## 7. Symbol Data Structure

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

## 8. formatSymbols

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

## 9. Module Structure

```
src/
  rummy.repo.js        Plugin entry. View handlers, turn.started listener.
  FileScanner.js       File sync, inline symbol extraction, diff gen, log://turn_0/manifest.
  ProjectContext.js     Git-aware file enumeration. Caches by HEAD hash.
  GitProvider.js        CLI git first, isomorphic-git fallback. Lazy loaded.
  CtagsExtractor.js    Universal Ctags wrapper. Synchronous child process.
  formatSymbols.js      Symbol array -> indented text tree.
```

---

## 10. Testing

| Tier | Location | Coverage |
|------|----------|----------|
| Unit | `src/*.test.js` | 80% line/branch/function threshold |

Tests use Node's built-in test runner (`node:test`) and assertion module
(`node:assert/strict`). FileScanner tests use temp directories with mock
store/db and verify inline symbol extraction, state/visibility values,
constraint handling, `log://turn_0/manifest` generation and idempotence
across re-scans, and `writer` attribution. GitProvider and ProjectContext
tests run against the real repo. Plugin tests verify the absence of any
`repo` scheme registration, the file-scheme summarized view handler,
guard clauses, and end-to-end scanning with symbol attachment via temp
git repos created with isomorphic-git.

```bash
npm test              # lint + unit tests with coverage
npm run test:unit     # unit tests only
npm run lint          # biome check
```
