# rummy.repo

File scanning and symbol extraction plugin for [Rummy](https://github.com/possumtech/rummy). Discovers project files via git, syncs them into the known store, and extracts symbols using [antlrmap](https://github.com/possumtech/antlrmap) (formal ANTLR4 grammars) with [Universal Ctags](https://ctags.io/) as a fallback.

Antlrmap relies on ANTLR4's Grammar Zoo, mapping the symbol extraction process from formal EBNF grammars. More academically rigorous than tree-sitter heuristics, more accurate than ctags regex patterns, and more amenable to obscure and domain-specific languages. Don't like it? This is why symbol extraction is a plugin -- swap it out.

## What It Does

Every turn, this plugin:

1. Enumerates project files from git (via CLI git, with isomorphic-git fallback)
2. Stats and hashes files to detect changes since the last scan
3. Extracts symbols inline from changed files during the scan
4. Writes file entries to the store with symbols attached as attributes
5. Generates diffs for files that changed since the last scan
6. Removes entries for files deleted from disk
7. Writes a navigable `repo://overview` entry with the project structure

Files start at `"archived"` visibility -- a 5000-file repo doesn't dump its full content into context. The model navigates via `repo://overview` (always visible) and promotes files to `"summarized"` (symbol tree) or `"visible"` (full content) as needed. The plugin preserves the model's visibility choices across re-scans.

## Supported Languages

Antlrmap provides grammar-based parsing for 36+ languages: JavaScript, TypeScript, Python, Rust, Go, Java, C, C++, Kotlin, PHP, Lua, SQL, Dart, Scala, Clojure, Elixir, Zig, R, Objective-C, Verilog, VHDL, Terraform, Fortran, Erlang, Thrift, GraphQL, AWK, JSON, TOML, Dockerfile, and more.

Files with unsupported extensions fall back to Universal Ctags (if installed).

## Installation

Configure via environment variable in your `.env`:

```env
RUMMY_PLUGIN_REPO=@possumtech/rummy.repo
```

Install the package:

```bash
npm install @possumtech/rummy.repo
```

Rummy loads external plugins from `RUMMY_PLUGIN_*` env vars on startup. No other configuration required.

## Usage

The plugin registers automatically via the Rummy v2 plugin contract. No manual setup needed.

```js
import RummyRepo from "@possumtech/rummy.repo";
new RummyRepo(core);
```

## Optional Dependencies

- **isomorphic-git** -- Pure JS git implementation. Used as a fallback when CLI `git` is not available. CLI git is preferred when present.
- **Universal Ctags** -- Fallback symbol extractor for languages not supported by antlrmap. Not required.

## Development

```bash
npm test          # lint + unit tests (80% coverage threshold)
npm run lint      # biome check
```

Requires Node.js >= 25.

## License

MIT -- PossumTech Laboratories
