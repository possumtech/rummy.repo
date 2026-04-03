# rummy.repo

Symbol extraction plugin for [Rummy](https://github.com/possumtech/rummy). Turns source files into structured symbol maps using [antlrmap](https://github.com/possumtech/antlrmap) (formal ANTLR4 grammars) with [Universal Ctags](https://ctags.io/) as a fallback.

Antlrmap relies on ANTLR4's Grammar Zoo, mapping the symbol extraction process from formal EBNF grammars. More academically rigorous than tree-sitter heuristics, more accurate than ctags regex patterns, and more amenable to obscure and domain-specific languages. Don't like it? This is why symbol extraction is a plugin -- swap it out in 20 lines.

## What It Does

When files change in a Rummy project, this plugin extracts their symbols (functions, classes, methods, fields) and returns them as structured data. Rummy stores the formatted symbol tree in file entry attributes, giving the model a compact map of the codebase without reading every file.

## Supported Languages

Antlrmap provides grammar-based parsing for 36+ languages: JavaScript, TypeScript, Python, Rust, Go, Java, C, C++, Kotlin, PHP, Lua, SQL, Dart, Scala, Clojure, Elixir, Zig, R, Objective-C, Verilog, VHDL, Terraform, Fortran, Erlang, Thrift, GraphQL, AWK, JSON, TOML, Dockerfile, and more.

Files with unsupported extensions fall back to Universal Ctags (if installed).

## Installation

Drop into your Rummy plugins directory:

```bash
cd ~/.rummy/plugins
git clone https://github.com/possumtech/rummy.repo
cd rummy.repo/main
npm install
```

Rummy loads plugins from `~/.rummy/plugins/` on startup. No configuration required.

## Usage

The plugin registers automatically via the standard Rummy plugin contract. No manual setup needed.

```js
// Rummy's plugin loader calls this automatically:
import RepoMapPlugin from "@possumtech/rummy.repo";
RepoMapPlugin.register(hooks);
```

### formatSymbols

The plugin exposes a `formatSymbols` helper for rendering symbol arrays as indented text:

```js
import RepoMapPlugin from "@possumtech/rummy.repo";

const text = RepoMapPlugin.formatSymbols(symbols);
// class MyClass L1
//   method doThing(a, b) L5
//   field name L3
```

## Development

```bash
npm test          # lint + unit tests (80% coverage threshold)
npm run lint      # biome check
```

Requires Node.js >= 25.

## License

MIT -- PossumTech Laboratories
