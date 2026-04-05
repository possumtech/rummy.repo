# rummy.repo: Architecture Specification

---

## 1. Plugin Contract

Implements the Rummy v0.2 plugin interface:

```js
export default class RepoMapPlugin {
    constructor(core) {
        core.on("entry.changed", this.#onChanged.bind(this));
    }
}
```

The plugin stores no reference to `core`. All runtime state comes from
the `rummy` context in event payloads.

Loading: Rummy's plugin loader scans `~/.rummy/plugins/`, enters the
`rummy.repo/` directory, and loads `rummy.repo.js` (matching the
`{dirname}.js` convention). The loader instantiates the class, passing
a `PluginContext` as the sole constructor argument.

---

## 2. Event Subscription

### `core.on("entry.changed", fn)`

The plugin subscribes to `entry.changed` events emitted by
FileScanner when files are modified on disk.

**Payload:**

```js
{
    rummy,    // RummyContext — auto-scoped to the current run
    runId,    // number
    turn,     // number
    paths     // string[] — relative file paths that changed
}
```

The plugin destructures `rummy` and `paths`. It does not use `runId`
or `turn` directly — RummyContext methods are already scoped to the run.

---

## 3. Extraction Pipeline

For each path in the `paths` array:

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
6. **Write attributes** for each path with non-empty ctags results

### 3.1 Antlrmap Integration

Antlrmap is a hard dependency (`@possumtech/antlrmap`). The supported
extension set is computed once at module load from `Antlrmap.extensions`.
A new `Antlrmap` instance is created per event. File content is read
from the store via `rummy.getBody(path)`, not from disk.

### 3.2 Ctags Fallback

`CtagsExtractor` wraps Universal Ctags in a synchronous child process.
Ctags operates on disk files, using `rummy.project.project_root` as
the working directory. If ctags is not installed (`ENOENT`) or returns non-zero, it
logs a warning and returns empty arrays. No error is thrown.

**Lua workaround**: ctags does not provide function signatures for Lua.
`CtagsExtractor` extracts them from the ctags `pattern` field using a
regex that handles both `function name(params)` and
`name = function(params)` forms.

---

## 4. Symbol Data Structure

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

## 5. Attribute Writing

After extraction, the plugin writes formatted symbols to the entry's
attributes using the merge-based `setAttributes` API:

```js
await rummy.setAttributes(path, { symbols: formatSymbols(symbols) });
```

This preserves any existing attributes on the entry (e.g., `constraint`)
and adds or replaces only the `symbols` key.

---

## 6. formatSymbols

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

## 7. Consumer Integration

The formatted symbol text flows through rummy's context assembly:

- **`v_model_context` VIEW**: files at `summary` state are categorized
  as `file_summary` (ordinal bucket 5, between `file_index` and `file`)
- **`ContextAssembler`**: renders `file_summary` entries as
  `#### {path} (summary)\n{symbols}` blocks in the system message

This gives the model a structural overview of files it hasn't read in
full — function names, class hierarchies, method signatures, and line
numbers — without consuming the token budget of full file content.

---

## 8. Module Structure

```
src/
  rummy.repo.js        Plugin entry point. Subscribes to entry.changed.
  CtagsExtractor.js    Universal Ctags wrapper. Synchronous child process.
  formatSymbols.js      Symbol array → indented text tree.
```

---

## 9. Testing

| Tier | Location | Coverage |
|------|----------|----------|
| Unit | `src/*.test.js` | 80% line/branch/function threshold |

Tests use Node's built-in test runner (`node:test`) and assertion module
(`node:assert/strict`). `CtagsExtractor` tests inject a mock
`spawnSync`. Plugin tests mock `PluginContext` and `RummyContext`,
using the plugin's own source files as fixtures for the antlrmap path.

```bash
npm test              # lint + unit tests with coverage
npm run test:unit     # unit tests only
npm run lint          # biome check
```
