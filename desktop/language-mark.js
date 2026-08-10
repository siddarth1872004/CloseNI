/*
 * A file's language, as a label and a colour token.
 *
 * Drawn rather than bundled: real language logos are trademarked brand assets,
 * and item 10 already made this call for provider logos. The extension in an
 * accent colour says the same thing and ships nothing.
 *
 * Loaded as a plain <script> in the renderer (window.CNLang) and require()d by
 * the test harness (module.exports). There is no bundler, so no import/export.
 */
(function (root) {
  // Families share an accent; the label keeps the real extension, so .cpp and
  // .c look related without looking identical.
  var FAMILIES = {
    "--lang-py": ["py", "pyw"],
    "--lang-rs": ["rs"],
    "--lang-js": ["js", "cjs", "mjs", "jsx", "ts", "tsx"],
    "--lang-java": ["java"],
    "--lang-c": ["c", "h", "cpp", "cc", "hpp", "cxx"],
  };

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

  var api = { languageMark: languageMark };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNLang = api;
})(typeof window !== "undefined" ? window : globalThis);
