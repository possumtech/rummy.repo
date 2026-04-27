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
        core.registerScheme({ name: "repo", category: "data" });
        core.on("turn.started", this.#onTurnStarted.bind(this));
        core.hooks.tools.onView("repo", fn, "visible");
        core.hooks.tools.onView("repo", fn, "summarized");
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

### `core.registerScheme({ name: "repo", category: "data" })`

Registers a new `repo://` URI scheme for entries describing the project
itself. Category `"data"` places it in the same projection family as
files. `model_visible` defaults to 1.

### `core.on("turn.started", fn)`

Fires every turn before context materialization. The plugin:

1. Checks `rummy.noRepo` -- skips if true
2. Checks `rummy.project.project_root` -- skips if absent
3. Lazily creates a FileScanner (once per plugin lifetime)
4. Opens a ProjectContext to enumerate git-tracked files
5. Runs `scanner.scan()` to sync file entries with inline symbol extraction

### `core.hooks.tools.onView("repo", fn, "visible")`

Full view: returns `entry.body` as-is.

### `core.hooks.tools.onView("repo", fn, "summarized")`

Truncated view: first 12 lines of the overview body, with a truncation
notice. Enough to read top-level structure without consuming full token
budget. Promote to visible to see the full tree.

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

Files default to `"archived"` on first scan. A 5000-file repo doesn't
dump 400K tokens into context before any work happens. The model
navigates via the `repo://overview` entry (always visible) and promotes
individual files to `"summarized"` or `"visible"` as needed.

| Visibility | What the model sees |
|------------|-------------------|
| `"visible"` | Full file content |
| `"summarized"` | Symbol tree from `attributes.symbols` |
| `"archived"` | Nothing (retrievable via `<get>`) |

The model controls promotion/demotion via `<set visibility="..."/>`.
The plugin preserves prior visibility on re-scan so the model's own
changes aren't clobbered. Only `constraint === "active"` forces
`"visible"`.

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
2. Include `active`-constrained files not in the git file list
3. Stat all files concurrently (no content reads), skip `ignore`-constrained
4. For each file with changed mtime: read content, compute SHA-256 hash
5. Skip if hash matches stored hash (mtime changed but content didn't)
6. If file existed before with different content, generate a diff via
   `hooks.hedberg.generatePatch` and write a `set://` entry
7. Extract symbols inline via antlrmap (ctags fallback queued)
8. Write to store via `store.set()` with `state: "resolved"`,
   visibility (`"visible"` for active, else preserve or `"archived"`),
   and `writer: "plugin"`
9. Batch ctags extraction for files antlrmap couldn't handle
10. Remove entries for files deleted from disk via `store.rm()`
11. Write `repo://overview` entry (always visible)

**Constraint matching** uses `hooks.hedberg.match` for pattern-based
constraints (glob, regex, etc.) rather than exact string equality.

**Store operations** use the v2 `store.set()` / `store.rm()` API with
named arguments and `writer: "plugin"` attribution.

---

## 5. repo://overview

A navigable project map written after each sync. Lives at
`repo://overview` with `visibility: "visible"`. Stays bounded
regardless of repo size.

**Content:**

```
# /path/to/project (N files)

## Root files
- package.json
- README.md
- ...

## Directories
- src/ — 42 files
- test/ — 12 files
- ...

## Constraints
- active: .env, config.js
- readonly: LICENSE

## Navigate
- Skim a folder's symbols: <set path="dir/**" visibility="summarized"/>
- Read a specific file: <get path="dir/file.ext"/>
- List a folder's files: <get path="dir/" preview/>
- Search across files: <get path="**" preview>keyword</get>
- Demote when done: <set path="dir/**" visibility="archived"/>
```

Root files listed (up to 50), directories shown with file counts sorted
by size, constraints listed if any exist. The navigation legend teaches
the model how to explore.

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
  rummy.repo.js        Plugin entry. Scheme registration, view handlers, turn.started.
  FileScanner.js       File sync, inline symbol extraction, diff gen, repo://overview.
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
constraint handling, repo://overview generation, and `writer`
attribution. GitProvider and ProjectContext tests run against the real
repo. Plugin tests verify scheme registration, view handlers (including
truncation), guard clauses, and end-to-end scanning with symbol
attachment via temp git repos created with isomorphic-git.

```bash
npm test              # lint + unit tests with coverage
npm run test:unit     # unit tests only
npm run lint          # biome check
```
