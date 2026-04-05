# rummy.repo: Architecture Specification

---

## 1. Plugin Contract

Implements the Rummy v0.2 plugin interface:

```js
export default class RummyRepo {
    #core;
    #scanner = null;

    constructor(core) {
        this.#core = core;
        core.on("turn.started", this.#onTurnStarted.bind(this));
        core.on("entry.changed", this.#onChanged.bind(this));
    }
}
```

Loading: external plugins are declared via `RUMMY_PLUGIN_REPO=@possumtech/rummy.repo`
in the environment. The loader imports the package, instantiates the class,
and passes a `PluginContext` as the sole constructor argument.

The plugin stores `core` for access to `core.db`, `core.hooks`, and
`core.hooks.hedberg.match` (pattern matching for file constraints).

---

## 2. Event Subscriptions

### `core.on("turn.started", fn)`

Fires every turn before context materialization. The plugin:

1. Checks `rummy.noContext` — skips if true (no-context runs)
2. Checks `rummy.project.project_root` — skips if absent
3. Lazily creates a FileScanner (once per plugin lifetime)
4. Opens a ProjectContext to enumerate git-tracked files
5. Runs `scanner.scan()` to sync file entries

### `core.on("entry.changed", fn)`

Fires after FileScanner detects changed files. The plugin:

1. Filters paths by file extension
2. Reads file bodies from the store via `rummy.getBody(path)`
3. Extracts symbols (antlrmap first, ctags fallback)
4. Writes formatted symbol text via `rummy.setAttributes(path, { symbols })`

---

## 3. File Scanning Pipeline

### 3.1 ProjectContext

Enumerates project files by combining git-tracked files with
database-stored file constraints.

```
ProjectContext.open(projectRoot, dbFiles?)
  → GitProvider.detectRoot()
  → GitProvider.getHeadHash()      // cache key
  → GitProvider.getTrackedFiles()  // Set<string>
  → filter to files under project root
  → merge with dbFiles
```

Results are cached by HEAD hash. A new commit invalidates the cache.

### 3.2 GitProvider

Pure JS git operations via isomorphic-git (optional dependency). Falls
back to CLI `git` commands if isomorphic-git is not installed.

| Method | Purpose |
|--------|---------|
| `detectRoot(path)` | Find `.git` root from any path |
| `getTrackedFiles(root)` | All files tracked by HEAD |
| `getHeadHash(root)` | Current HEAD commit hash |
| `isIgnored(root, path)` | Check `.gitignore` |

### 3.3 FileScanner

Syncs the filesystem into the known store for all active runs.

**Per-scan flow:**

1. Load active runs and file constraints from the database
2. Include `active`-constrained files not in the git file list
3. Stat all files concurrently (no content reads), skip `ignore`-constrained
4. For each file with changed mtime: read content, compute SHA-256 hash
5. Skip if hash matches stored hash (mtime changed but content didn't)
6. Upsert into known store with appropriate state (`full` for active, else preserve or `index`)
7. Emit `entry.changed` with all changed paths
8. Process truly new files (not in store at all)
9. Remove entries for files deleted from disk

**Constraint matching** uses `hooks.hedberg.match` for pattern-based
constraints (glob, regex, etc.) rather than exact string equality.

---

## 4. Symbol Extraction Pipeline

For each path in the `entry.changed` payload:

1. **Skip** if the path has no file extension
2. **Check extension** against antlrmap's supported set
3. **If supported**: read file body from the store via
   `rummy.getBody(path)`, parse with `antlrmap.mapSource(body, ext)`
   - If symbols are returned, format and write attributes, move to next
   - If antlrmap returns empty or throws, fall through to ctags
4. **If unsupported or antlrmap failed**: queue for ctags

After all paths are processed:

5. **Ctags batch**: invoke `ctags --output-format=json --fields=+nS`
   as a single synchronous child process against all queued paths
6. **Write attributes** for each path with non-empty results

### 4.1 Antlrmap Integration

Antlrmap is a hard dependency (`@possumtech/antlrmap`). The supported
extension set is computed once at module load from `Antlrmap.extensions`.
A new `Antlrmap` instance is created per event. File content is read
from the store via `rummy.getBody(path)`, not from disk.

### 4.2 Ctags Fallback

`CtagsExtractor` wraps Universal Ctags in a synchronous child process.
Ctags operates on disk files, using `rummy.project.project_root` as
the working directory. If ctags is not installed (`ENOENT`) or returns
non-zero, it logs a warning and returns empty arrays. No error is thrown.

**Lua workaround**: ctags does not provide function signatures for Lua.
`CtagsExtractor` extracts them from the ctags `pattern` field using a
regex that handles both `function name(params)` and
`name = function(params)` forms.

---

## 5. Symbol Data Structure

Each symbol in the antlrmap output:

```js
{
    name: "functionName",       // required
    kind: "function",           // function, class, method, field, interface, enum
    params: ["a", "b"],         // array or string; optional
    line: 42,                   // 1-based line number; optional
    endLine: 50                 // used for nesting; optional
}
```

Ctags-sourced symbols use a slightly different shape:

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

## 6. Attribute Writing

After extraction, the plugin writes formatted symbols to the entry's
attributes using the merge-based `setAttributes` API:

```js
await rummy.setAttributes(path, { symbols: formatSymbols(symbols) });
```

This preserves any existing attributes on the entry (e.g., `constraint`)
and adds or replaces only the `symbols` key.

---

## 7. formatSymbols

Internal formatter that converts symbol arrays to indented text.

### Algorithm

1. Sort symbols by `line` (ascending, `0` for missing)
2. Maintain a stack of "open" parent symbols (those with `endLine`)
3. For each symbol:
   - Pop parents whose `endLine` has been passed
   - Indent by stack depth (2 spaces per level)
   - Format as `{indent}{kind} {name}({params}) L{line}`
   - Push onto stack if it has a valid `endLine` range

### Output Format

```
class MyClass L1
  method doThing(a, b) L5
  field name L3
  method other() L12
    function nested(x) L15
class AnotherClass L25
```

Nesting is derived from `line`/`endLine` ranges, not explicit parent
references. Params render as comma-joined if array, raw if string.
Kind and line are omitted when absent.

---

## 8. Consumer Integration

The formatted symbol text flows through rummy's context assembly:

- **`v_model_context` VIEW**: files at `summary` state are categorized
  as `file_summary` (ordinal bucket 5, between `file_index` and `file`)
- **`ContextAssembler`**: renders `file_summary` entries as
  `#### {path} (summary)\n{symbols}` blocks in the system message

This gives the model a structural overview of files it hasn't read in
full — function names, class hierarchies, method signatures, and line
numbers — without consuming the token budget of full file content.

---

## 9. Module Structure

```
src/
  rummy.repo.js        Plugin entry point. Subscribes to turn.started and entry.changed.
  FileScanner.js       Filesystem sync. Stats, hashes, upserts, emits entry.changed.
  ProjectContext.js     Git-aware file enumeration. Caches by HEAD hash.
  GitProvider.js        Git operations via isomorphic-git with CLI fallback.
  CtagsExtractor.js    Universal Ctags wrapper. Synchronous child process.
  formatSymbols.js      Symbol array → indented text tree.
```

---

## 10. Testing

| Tier | Location | Coverage |
|------|----------|----------|
| Unit | `src/*.test.js` | 80% line/branch/function threshold |

Tests use Node's built-in test runner (`node:test`) and assertion module
(`node:assert/strict`). `CtagsExtractor` tests inject a mock
`spawnSync`. FileScanner tests use temp directories with mock store/db.
GitProvider and ProjectContext tests run against the real repo.
Plugin tests mock `PluginContext` and `RummyContext`, using the
plugin's own source files as fixtures for the antlrmap path.
The `turn.started` integration test creates a temp git repo via
isomorphic-git.

```bash
npm test              # lint + unit tests with coverage
npm run test:unit     # unit tests only
npm run lint          # biome check
```
