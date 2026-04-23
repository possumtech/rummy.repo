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

## 3. File Scanning Pipeline

### 3.1 ProjectContext

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

### 3.2 GitProvider

CLI `git` first, with isomorphic-git (optional dependency) as fallback
when git is not installed. CLI availability is checked once at module
load. isomorphic-git is lazy-loaded only if needed.

| Method | Purpose |
|--------|---------|
| `detectRoot(path)` | Find `.git` root from any path |
| `getTrackedFiles(root)` | All files tracked by HEAD |
| `getHeadHash(root)` | Current HEAD commit hash |
| `isIgnored(root, path)` | Check `.gitignore` |

### 3.3 FileScanner

Syncs the filesystem into the known store for all active runs. Symbols
are extracted inline during the scan -- not via a separate event.

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
   visibility (`"visible"` for active, else `"summarized"`), and
   `writer: "plugin"`
9. Batch ctags extraction for files antlrmap couldn't handle
10. Remove entries for files deleted from disk via `store.rm()`

**Constraint matching** uses `hooks.hedberg.match` for pattern-based
constraints (glob, regex, etc.) rather than exact string equality.

**Store operations** use the v2 `store.set()` / `store.rm()` API with
named arguments and `writer: "plugin"` attribution.

---

## 4. Symbol Extraction

Symbols are extracted inline during the file scan, not as a separate
step. Each file write carries its `attributes.symbols` if extraction
succeeded.

### 4.1 Antlrmap (Primary)

A single `Antlrmap` instance is created when the FileScanner is
constructed and reused across all scans. For each changed file with a
supported extension, `antlrmap.mapSource(content, ext)` is called. If
symbols are returned, they are formatted and attached to the write.

### 4.2 Ctags (Fallback)

Files where antlrmap returns no symbols or has no grammar are queued
for a single batched `ctags --output-format=json --fields=+nS`
invocation. Results are written back as attribute-only updates via
`store.set()`.

**Lua workaround**: ctags does not provide function signatures for Lua.
`CtagsExtractor` extracts them from the ctags `pattern` field.

---

## 5. Symbol Data Structure

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

## 6. formatSymbols

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

## 7. Module Structure

```
src/
  rummy.repo.js        Plugin entry. turn.started handler, summarized view registration.
  FileScanner.js       File sync with inline symbol extraction. Diff generation.
  ProjectContext.js     Git-aware file enumeration. Caches by HEAD hash.
  GitProvider.js        CLI git first, isomorphic-git fallback. Lazy loaded.
  CtagsExtractor.js    Universal Ctags wrapper. Synchronous child process.
  formatSymbols.js      Symbol array -> indented text tree.
```

---

## 8. Testing

| Tier | Location | Coverage |
|------|----------|----------|
| Unit | `src/*.test.js` | 80% line/branch/function threshold |

Tests use Node's built-in test runner (`node:test`) and assertion module
(`node:assert/strict`). FileScanner tests use temp directories with mock
store/db and verify inline symbol extraction, state/visibility values,
constraint handling, visibility values, and `writer` attribution. GitProvider and
ProjectContext tests run against the real repo. Plugin tests verify
view registration, guard clauses, and end-to-end scanning with symbol
attachment via temp git repos created with isomorphic-git.

```bash
npm test              # lint + unit tests with coverage
npm run test:unit     # unit tests only
npm run lint          # biome check
```
