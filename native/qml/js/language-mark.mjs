/*
 * A file's language, as a label and a colour token.
 *
 * Drawn rather than bundled: real language logos are trademarked brand assets,
 * and item 10 already made this call for provider logos. The extension in an
 * accent colour says the same thing and ships nothing.
 *
 * An ES module imported by the QML app and by the test harness.
 */
// Families share an accent; the label keeps the real extension, so .cpp and
// .c look related without looking identical.
// Five accents for many languages, so the grouping is by kinship: dynamic
// scripting languages with Python, the web with JavaScript, JVM and .NET
// with Java, systems languages with C, and ML-family and other typed
// functional languages with Rust.
var FAMILIES = {
  "--lang-py": ["py", "pyw", "pyi", "ipynb", "rb", "php", "pl", "pm", "lua", "r", "jl", "ex", "exs", "erl", "hrl",
    "sh", "bash", "zsh", "fish", "ps1", "tcl", "cr", "nim", "raku"],
  "--lang-rs": ["rs", "hs", "lhs", "ml", "mli", "fs", "fsi", "fsx", "elm", "purs", "idr", "agda", "lean", "re", "res", "gleam", "sml"],
  "--lang-js": ["js", "cjs", "mjs", "jsx", "ts", "tsx", "mts", "cts", "vue", "svelte", "astro", "dart", "coffee",
    "html", "htm", "css", "scss", "sass", "less"],
  "--lang-java": ["java", "kt", "kts", "scala", "sc", "groovy", "gradle", "clj", "cljs", "cljc", "edn", "cs", "vb", "fsproj", "csproj"],
  "--lang-c": ["c", "h", "cpp", "cc", "hpp", "cxx", "hh", "m", "mm", "go", "zig", "swift", "d", "v", "odin", "cu",
    "asm", "s", "f", "f90", "f95", "pas", "ada", "adb", "cob", "sol", "wat"],
};

// Language names, as the checks and GitHub report them, to the same families.
var NAMES = {
  "--lang-py": ["python", "ruby", "php", "perl", "lua", "r", "julia", "elixir", "erlang", "shell", "bash", "powershell",
    "tcl", "crystal", "nim", "raku"],
  "--lang-rs": ["rust", "haskell", "ocaml", "f#", "fsharp", "elm", "purescript", "idris", "lean", "reason", "rescript", "gleam", "sml"],
  "--lang-js": ["javascript", "typescript", "node", "deno", "bun", "dart", "flutter", "vue", "svelte", "coffeescript", "html", "css"],
  "--lang-java": ["java", "kotlin", "scala", "groovy", "clojure", "c#", "csharp", ".net", "dotnet", "visual basic"],
  "--lang-c": ["c", "cpp", "c++", "objective-c", "go", "zig", "swift", "d", "v", "odin", "cuda", "assembly", "fortran",
    "pascal", "ada", "cobol", "solidity", "cmake"],
};
var BY_NAME = {};
Object.keys(NAMES).forEach(function (token) {
  NAMES[token].forEach(function (n) { BY_NAME[n] = token; });
});

function languageToken(name) {
  return BY_NAME[String(name || "").trim().toLowerCase()] || "--lang-default";
}

var BY_EXT = {};
Object.keys(FAMILIES).forEach(function (token) {
  FAMILIES[token].forEach(function (ext) { BY_EXT[ext] = token; });
});

function languageMark(filePath) {
  var name = String(filePath || "").replace(/\\/g, "/").split("/").pop() || "";
  var dot = name.lastIndexOf(".");
  // dot === 0 is a dotfile, not an extension: .gitignore is not a "gitignore"
  // file, and labelling it as one would be wrong on every dotfile row.
  var ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (!ext) return { label: "—", token: "--lang-default" };
  return {
    label: ext.length > 4 ? ext.slice(0, 4) : ext,
    token: BY_EXT[ext] || "--lang-default",
  };
}

export {
  languageMark,
  languageToken,
};
