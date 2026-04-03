# rummy.repo: Architecture Specification

---

## 1. Plugin Contract

Implements the standard Rummy plugin interface:

```js
export default class RepoMapPlugin {
    static register(hooks) { ... }
}
```

Loading: Rummy's plugin loader scans `~/.rummy/plugins/`, enters the
`rummy.repo/` directory, and loads `rummy.repo.js` (matching the
`{dirname}.js` convention). The loader calls
`RepoMapPlugin.register(hooks)` during startup.

---

## 2. Filter Registration

### `hooks.file.symbols` (priority 50)

The plugin registers a single filter on the `file.symbols` hook.

```js
hooks.file.symbols.addFilter(async (symbolMap, { paths, projectPath }) => {
    // ...
    return result;
}, 50);
```

| Property | Type | Description |
|----------|------|-------------|
| `symbolMap` | `Map<string, symbol[]>` | Input map, empty or partially populated by earlier filters |
| `paths` | `string[]` | Relative file paths that changed since last scan |
| `projectPath` | `string` | Absolute path to the project root |
| **Returns** | `Map<string, symbol[]>` | Merged map with symbols for each file that could be parsed |

The filter does not overwrite paths already present in the input map.
This allows higher-priority filters to provide symbols for specific
files, with this plugin filling in the rest.

---

## 3. Symbol Data Structure

Each symbol in the output arrays:

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

## 4. Extraction Pipeline

For each path in the `paths` array:

1. **Skip** if the path already exists in the input map
2. **Check extension** against antlrmap's supported set
3. **If supported**: read file content, parse with `antlrmap.mapSource(content, ext)`
   - If symbols are returned, add to result map and move to next file
   - If antlrmap returns empty or throws, fall through to ctags
4. **If unsupported or antlrmap failed**: queue the path for ctags

After all paths are processed:

5. **Ctags batch**: invoke `ctags --output-format=json --fields=+nS -f - <paths>`
   as a single synchronous child process
6. **Merge** ctags results into the map (only paths with non-empty symbol arrays)

### 4.1 Antlrmap Integration

Antlrmap is a hard dependency (`@possumtech/antlrmap`). The supported
extension set is computed once at module load from `Antlrmap.extensions`.
A new `Antlrmap` instance is created per filter invocation. File content
is read synchronously via `readFileSync`.

### 4.2 Ctags Fallback

`CtagsExtractor` wraps Universal Ctags in a synchronous child process.
If ctags is not installed (`ENOENT`) or returns non-zero, it logs a
warning and returns empty arrays for all queued paths. No error is
thrown -- the plugin degrades gracefully.

**Lua workaround**: ctags does not provide function signatures for Lua.
`CtagsExtractor` extracts them from the ctags `pattern` field using a
regex that handles both `function name(params)` and
`name = function(params)` forms.

---

## 5. Consumer Integration

Rummy's `FileScanner` is the primary consumer of this filter. During
project sync:

1. FileScanner identifies changed files (by mtime, then content hash)
2. Fires `hooks.file.symbols.filter(new Map(), { paths, projectPath })`
3. For each file in the returned map, calls `formatSymbols(symbols)` to
   produce an indented text tree
4. Stores the formatted text in the file entry's `attributes.symbols`
   via `knownStore.upsert()`

The `attributes.symbols` value flows through:

- **`v_model_context` VIEW**: files at `summary` state are categorized
  as `file_summary` (ordinal bucket 5, between `file_index` and `file`)
- **`ContextAssembler`**: renders `file_summary` entries as
  `#### {path} (summary)\n{symbols}` blocks in the system message

This gives the model a structural overview of files it hasn't read in
full -- function names, class hierarchies, method signatures, and line
numbers -- without consuming the token budget of the full file content.

---

## 6. formatSymbols

Exposed as `RepoMapPlugin.formatSymbols` for consumers that need to
render symbol arrays as text.

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

Nesting is derived from `line`/`endLine` ranges, not from explicit
parent references. Params render as comma-joined if array, raw if
string. Kind and line are omitted when absent.

---

## 7. Module Structure

```
src/
  rummy.repo.js        Plugin entry point. Registers the file.symbols filter.
  CtagsExtractor.js    Universal Ctags wrapper. Synchronous child process.
  formatSymbols.js      Symbol array → indented text tree.
```

---

## 8. Testing

| Tier | Location | Coverage |
|------|----------|----------|
| Unit | `src/*.test.js` | 80% line/branch/function threshold |

Tests use Node's built-in test runner (`node:test`) and assertion module
(`node:assert/strict`). `CtagsExtractor` tests inject a mock
`spawnSync` to avoid requiring ctags on CI. The plugin filter test uses
the plugin's own source files as fixtures to exercise the full antlrmap
path.

```bash
npm test              # lint + unit tests with coverage
npm run test:unit     # unit tests only
npm run lint          # biome check
```
