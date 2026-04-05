# rummy.repo

File scanning and symbol extraction plugin for [Rummy](https://github.com/possumtech/rummy). Discovers project files via git, syncs them into the known store, detects changes, and extracts symbols using [antlrmap](https://github.com/possumtech/antlrmap) (formal ANTLR4 grammars) with [Universal Ctags](https://ctags.io/) as a fallback.

Antlrmap relies on ANTLR4's Grammar Zoo, mapping the symbol extraction process from formal EBNF grammars. More academically rigorous than tree-sitter heuristics, more accurate than ctags regex patterns, and more amenable to obscure and domain-specific languages. Don't like it? This is why symbol extraction is a plugin -- swap it out.

## What It Does

Every turn, this plugin:

1. Enumerates project files from git (via isomorphic-git or CLI fallback)
2. Stats and hashes files to detect changes since the last scan
3. Syncs file entries into the known store (upsert changed, remove deleted)
4. Emits `entry.changed` with the list of modified paths
5. Reacts to `entry.changed` by extracting symbols from changed files
6. Writes formatted symbol trees into each file entry's `attributes.symbols`

The model gets a compact structural overview of the codebase -- function names, class hierarchies, method signatures, line numbers -- without reading every file in full.

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

The plugin registers automatically via the Rummy v0.2 plugin contract. No manual setup needed.

```js
import RummyRepo from "@possumtech/rummy.repo";
new RummyRepo(core);
```

## Optional Dependencies

- **isomorphic-git** -- Pure JS git implementation. Used for file enumeration and HEAD detection. Falls back to CLI `git` commands if not installed.
- **Universal Ctags** -- Fallback symbol extractor for languages not supported by antlrmap. Not required.

## Development

```bash
npm test          # lint + unit tests (80% coverage threshold)
npm run lint      # biome check
```

Requires Node.js >= 25.

## License

MIT -- PossumTech Laboratories
