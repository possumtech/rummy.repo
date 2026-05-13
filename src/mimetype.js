// Extension → mimetype lookup. rummy.repo's slot in the precedence
// chain (explicit attr → extension → engine default text/markdown)
// per rummy SPEC #mimetype. Lookup is the file scanner's source of
// truth; entries the scanner writes carry the mimetype attribute so
// downstream consumers (engine, model) see the right shape.

const BY_EXTENSION = new Map([
	// Markdown / plain text
	[".md", "text/markdown"],
	[".markdown", "text/markdown"],
	[".txt", "text/plain"],
	// Structured data
	[".json", "application/json"],
	[".xml", "application/xml"],
	[".yaml", "application/yaml"],
	[".yml", "application/yaml"],
	[".toml", "application/toml"],
	[".csv", "text/csv"],
	[".tsv", "text/tab-separated-values"],
	// Code
	[".js", "text/javascript"],
	[".mjs", "text/javascript"],
	[".cjs", "text/javascript"],
	[".jsx", "text/javascript"],
	[".ts", "text/typescript"],
	[".tsx", "text/typescript"],
	[".py", "text/x-python"],
	[".rb", "text/x-ruby"],
	[".go", "text/x-go"],
	[".rs", "text/x-rust"],
	[".java", "text/x-java"],
	[".c", "text/x-c"],
	[".h", "text/x-c"],
	[".cpp", "text/x-c++"],
	[".cc", "text/x-c++"],
	[".cs", "text/x-csharp"],
	[".php", "text/x-php"],
	[".sh", "application/x-sh"],
	[".bash", "application/x-sh"],
	[".zsh", "application/x-sh"],
	[".fish", "application/x-sh"],
	[".sql", "application/sql"],
	// Web
	[".html", "text/html"],
	[".htm", "text/html"],
	[".css", "text/css"],
	[".scss", "text/x-scss"],
	[".sass", "text/x-sass"],
	[".less", "text/x-less"],
	// Config
	[".ini", "text/plain"],
	[".env", "text/plain"],
	[".conf", "text/plain"],
	[".cfg", "text/plain"],
	// Images (binary)
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".gif", "image/gif"],
	[".webp", "image/webp"],
	[".svg", "image/svg+xml"],
	[".ico", "image/x-icon"],
	[".bmp", "image/bmp"],
	[".tiff", "image/tiff"],
	// Audio (binary)
	[".mp3", "audio/mpeg"],
	[".wav", "audio/wav"],
	[".ogg", "audio/ogg"],
	[".flac", "audio/flac"],
	// Video (binary)
	[".mp4", "video/mp4"],
	[".webm", "video/webm"],
	[".mov", "video/quicktime"],
	// Documents (binary)
	[".pdf", "application/pdf"],
	[".zip", "application/zip"],
	[".tar", "application/x-tar"],
	[".gz", "application/gzip"],
	[".7z", "application/x-7z-compressed"],
	[".rar", "application/vnd.rar"],
	// Fonts (binary)
	[".woff", "font/woff"],
	[".woff2", "font/woff2"],
	[".ttf", "font/ttf"],
	[".otf", "font/otf"],
]);

const DEFAULT_MIMETYPE = "text/markdown";

export function mimetypeFromPath(path) {
	if (!path) return DEFAULT_MIMETYPE;
	const dot = path.lastIndexOf(".");
	if (dot < 0) return DEFAULT_MIMETYPE;
	const slash = path.lastIndexOf("/");
	if (dot < slash) return DEFAULT_MIMETYPE;
	const ext = path.slice(dot).toLowerCase();
	return BY_EXTENSION.get(ext) ?? DEFAULT_MIMETYPE;
}
