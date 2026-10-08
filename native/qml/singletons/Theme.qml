pragma Singleton
import QtQuick
import CloseNI
import "../js/theme.mjs" as T

/*
 * Every token desktop/styles.css held: the structural scale, the eleven
 * palettes, the fonts and the decoration. Switched at run time with
 * setTheme / setDecor and remembered under the same keys theme.js used
 * (closeni.theme, closeni.theme.decor).
 *
 * The CSS shadows (blurred box-shadow, text-shadow glow) have no cheap Qt
 * Quick equivalent without a shader effect, so components draw shadow1 /
 * shadow2 as offset translucent rects and glow as a soft text outline.
 */
QtObject {
    id: theme

    // ---- Which theme ----------------------------------------------------
    readonly property var themes: T.THEMES
    readonly property string defaultTheme: T.DEFAULT_THEME
    property string current: T.resolveTheme(Prefs.get(T.THEME_KEY, T.DEFAULT_THEME))
    // "on" unless switched off; the toggle only shows on a theme with decor.
    property bool decor: Prefs.get(T.DECOR_KEY, "on") !== "off"

    function setTheme(id) {
        current = T.resolveTheme(id)
        Prefs.set(T.THEME_KEY, current)
    }
    function setDecor(on) {
        decor = !!on
        Prefs.set(T.DECOR_KEY, decor ? "on" : "off")
    }
    /** The palette of any theme, for the Appearance swatches. */
    function palette(id) { return palettes[T.resolveTheme(id)] }
    function themeMeta(id) {
        for (var i = 0; i < themes.length; i++) if (themes[i].id === id) return themes[i]
        return null
    }
    readonly property bool hasDecor: { var m = themeMeta(current); return !!(m && m.decor) }

    readonly property bool isTerminal: current === "terminal"
    readonly property bool isPixel: current === "pixel"
    // Pixel squares every corner (rail cards, buttons, inputs, toasts, flow, console).
    readonly property bool square: isPixel
    // Decoration that moves runs only while the window is in front: a
    // backgrounded app has no business waking the GPU for a blinking cursor.
    readonly property bool animate: decor && Qt.application.state === Qt.ApplicationActive

    // ---- Structural scale (identical in every theme) --------------------
    readonly property int sp1: 4
    readonly property int sp2: 6
    readonly property int sp3: 8
    readonly property int sp4: 12
    readonly property int sp5: 14
    readonly property int sp6: 20
    readonly property int rSm: square ? 0 : 2
    readonly property int rMd: square ? 0 : 3
    readonly property int rLg: square ? 0 : 6
    readonly property int durFast: 120
    readonly property int durSlow: 400

    // ---- Fonts: the same system stacks styles.css named -------------------
    // body: "Segoe UI", system-ui, sans-serif
    // mono: ui-monospace, "Cascadia Mono", Consolas, monospace
    // ui-monospace is SF Mono on macOS (Menlo before it).
    function firstFamily(list, fallback) {
        var have = Qt.fontFamilies()
        for (var i = 0; i < list.length; i++) if (have.indexOf(list[i]) >= 0) return list[i]
        return fallback
    }
    readonly property string sans: firstFamily(["Segoe UI"], Qt.application.font.family)
    readonly property string mono: firstFamily(["SF Mono", "Menlo", "Cascadia Mono", "Consolas"], "monospace")
    // Terminal sets the whole body in the monospace stack at 13px.
    readonly property string ui: isTerminal ? mono : sans
    readonly property int bodySize: isTerminal ? 13 : 14
    readonly property int microSize: 10
    readonly property int hintSize: 11
    readonly property int inputSize: 12
    readonly property real microSpacing: 1.4   // .14em of 10px
    readonly property real btnSpacing: 0.88    // .08em of 11px

    // ---- Palettes ---------------------------------------------------------
    function rgba(r, g, b, a) { return Qt.rgba(r / 255, g / 255, b / 255, a) }

    readonly property var palettes: ({
        "midnight": {
            bg: "#0b0b0c", panel: "#101012", surface: "#0e0e10", surfaceRaised: "#17171a", surfaceSunken: "#050506",
            overlay: rgba(0, 0, 0, .7), line: "#232326", lineStrong: "#2e2e33", lineFocus: "#6f7ce0",
            txt: "#e8e8ea", dim: "#9b9ba3", mut: "#66666e", inverse: "#0b0b0c",
            ok: "#8fe0a8", okBg: "#0d2416", okLine: "#2c4f39",
            warn: "#e0cf8f", warnBg: "#211f13", warnLine: "#5c5327",
            err: "#eda1a6", errBg: "#2a1214", errLine: "#5c2c2f",
            langPy: "#78c0e0", langRs: "#e0a878", langJs: "#e0cf8f", langJava: "#e08f96", langC: "#a49ce0", langDefault: "#9b9ba3",
            shadow1: rgba(0, 0, 0, .5), shadow2: rgba(0, 0, 0, .75),
            texture: "", accent: "#e0a878", glow: "transparent", glowRadius: 0
        },
        "paper": {
            bg: "#f7f7f5", panel: "#ffffff", surface: "#ffffff", surfaceRaised: "#eeeee9", surfaceSunken: "#f0f0ec",
            overlay: rgba(40, 40, 38, .45), line: "#ddddd7", lineStrong: "#c6c6bf", lineFocus: "#3b4fd8",
            txt: "#1b1b1d", dim: "#55555a", mut: "#8a8a84", inverse: "#f7f7f5",
            ok: "#2f6b45", okBg: "#eaf6ee", okLine: "#a8d4b6",
            warn: "#7a6520", warnBg: "#faf5e2", warnLine: "#d8c98a",
            err: "#9c2f38", errBg: "#fbeced", errLine: "#e0b0b4",
            langPy: "#1f5f85", langRs: "#a85c22", langJs: "#7a6520", langJava: "#9c2f38", langC: "#4a448a", langDefault: "#55555a",
            shadow1: rgba(40, 40, 38, .14), shadow2: rgba(40, 40, 38, .2),
            texture: "", accent: "#b3541e", glow: "transparent", glowRadius: 0
        },
        "phosphor": {
            bg: "#020a04", panel: "#04140a", surface: "#04140a", surfaceRaised: "#0a2412", surfaceSunken: "#010603",
            overlay: rgba(0, 10, 4, .78), line: "#12401f", lineStrong: "#2f8a52", lineFocus: "#7bffa0",
            txt: "#9dffb8", dim: "#4ec46f", mut: "#2f8a52", inverse: "#020a04",
            ok: "#7bffa0", okBg: "#04240f", okLine: "#2f8a52",
            warn: "#d8ff7b", warnBg: "#141f04", warnLine: "#6b8a2f",
            err: "#ff9d8f", errBg: "#240a06", errLine: "#8a3f2f",
            langPy: "#7bffd8", langRs: "#d8ff7b", langJs: "#b8ff7b", langJava: "#ff9d8f", langC: "#7bd8ff", langDefault: "#4ec46f",
            shadow1: rgba(0, 0, 0, .6), shadow2: rgba(0, 0, 0, .8),
            texture: "scan-phosphor", accent: "#d8ff7b", glow: rgba(80, 255, 140, .55), glowRadius: 8
        },
        "amber": {
            bg: "#0c0703", panel: "#150c04", surface: "#150c04", surfaceRaised: "#241407", surfaceSunken: "#080402",
            overlay: rgba(12, 7, 3, .78), line: "#40260c", lineStrong: "#8a5a20", lineFocus: "#ffc06b",
            txt: "#ffd9a0", dim: "#c4913f", mut: "#8a5a20", inverse: "#0c0703",
            ok: "#c8e06b", okBg: "#1a2407", okLine: "#6b8a2f",
            warn: "#ffc06b", warnBg: "#241a07", warnLine: "#8a6520",
            err: "#ff9b7b", errBg: "#240e06", errLine: "#8a3f2f",
            langPy: "#6bc8e0", langRs: "#ffc06b", langJs: "#e0cf8f", langJava: "#ff9b7b", langC: "#c8a0e0", langDefault: "#c4913f",
            shadow1: rgba(0, 0, 0, .6), shadow2: rgba(0, 0, 0, .8),
            texture: "scan-amber", accent: "#ffc06b", glow: rgba(255, 170, 70, .5), glowRadius: 8
        },
        "cassette-indigo": {
            bg: "#07060f", panel: "#0d0a1c", surface: "#0d0a1c", surfaceRaised: "#171233", surfaceSunken: "#040309",
            overlay: rgba(7, 6, 15, .78), line: "#241c47", lineStrong: "#5a2a6e", lineFocus: "#f08cff",
            txt: "#e6e2ff", dim: "#a49ce0", mut: "#6a5fa8", inverse: "#07060f",
            ok: "#4fe0d0", okBg: "#07211f", okLine: "#1f6b6b",
            warn: "#f08cff", warnBg: "#220e2a", warnLine: "#a83fc4",
            err: "#ff7b9d", errBg: "#24060f", errLine: "#8a2f4a",
            langPy: "#4fe0d0", langRs: "#ffb03f", langJs: "#f0e08c", langJava: "#ff7b9d", langC: "#a49ce0", langDefault: "#a49ce0",
            shadow1: rgba(0, 0, 0, .6), shadow2: rgba(0, 0, 0, .8),
            texture: "scan-cassette-indigo", accent: "#f08cff", glow: rgba(200, 120, 255, .5), glowRadius: 8
        },
        "cassette-miami": {
            bg: "#0a0512", panel: "#150a1e", surface: "#150a1e", surfaceRaised: "#241033", surfaceSunken: "#05020a",
            overlay: rgba(10, 5, 18, .78), line: "#3a1430", lineStrong: "#8a3050", lineFocus: "#ffb03f",
            txt: "#ffe0ee", dim: "#e0a0c8", mut: "#a05a86", inverse: "#0a0512",
            ok: "#4fe0d0", okBg: "#07211f", okLine: "#1f6b6b",
            warn: "#ffc86b", warnBg: "#2a1a06", warnLine: "#ffb03f",
            err: "#ff5aa0", errBg: "#2a0616", errLine: "#8a3050",
            langPy: "#4fe0d0", langRs: "#ffb03f", langJs: "#ffc86b", langJava: "#ff5aa0", langC: "#c88ce0", langDefault: "#e0a0c8",
            shadow1: rgba(0, 0, 0, .6), shadow2: rgba(0, 0, 0, .8),
            texture: "scan-cassette-miami", accent: "#ffb03f", glow: rgba(255, 90, 150, .5), glowRadius: 8
        },
        "cassette-grid": {
            bg: "#03080e", panel: "#061420", surface: "#061420", surfaceRaised: "#0a2033", surfaceSunken: "#020509",
            overlay: rgba(3, 8, 14, .78), line: "#0e2c3f", lineStrong: "#1d6f9c", lineFocus: "#5fd8ff",
            txt: "#dff4ff", dim: "#8fc4e0", mut: "#3d7a9c", inverse: "#03080e",
            ok: "#4fe08f", okBg: "#07211a", okLine: "#1f6b4a",
            warn: "#e0d08f", warnBg: "#21200e", warnLine: "#6b6320",
            err: "#ff8f9d", errBg: "#240a0e", errLine: "#8a2f3a",
            langPy: "#5fd8ff", langRs: "#e0a878", langJs: "#e0d08f", langJava: "#ff8f9d", langC: "#9c8fe0", langDefault: "#8fc4e0",
            shadow1: rgba(0, 0, 0, .6), shadow2: rgba(0, 0, 0, .8),
            texture: "", accent: "#5fd8ff", glow: rgba(95, 216, 255, .5), glowRadius: 9
        },
        "blueprint": {
            bg: "#081a2e", panel: "#0b2540", surface: "#0b2540", surfaceRaised: "#123350", surfaceSunken: "#05131f",
            overlay: rgba(8, 26, 46, .78), line: "#1c4468", lineStrong: "#4c86b8", lineFocus: "#c8e4ff",
            txt: "#e8f4ff", dim: "#a8ccea", mut: "#5f8fb8", inverse: "#081a2e",
            ok: "#7fd8a8", okBg: "#0d2a1e", okLine: "#3f7a5c",
            warn: "#e8cf8f", warnBg: "#2a2410", warnLine: "#8a7a3f",
            err: "#f0a0a8", errBg: "#2a1218", errLine: "#8a4550",
            langPy: "#8fd8f0", langRs: "#e8b48f", langJs: "#e8cf8f", langJava: "#f0a0a8", langC: "#b0a8f0", langDefault: "#a8ccea",
            shadow1: rgba(0, 0, 0, .45), shadow2: rgba(0, 0, 0, .65),
            texture: "grid-blueprint", accent: "#e8cf8f", glow: "transparent", glowRadius: 0
        },
        "contrast": {
            bg: "#000000", panel: "#0a0a0a", surface: "#0a0a0a", surfaceRaised: "#1a1a1a", surfaceSunken: "#000000",
            overlay: rgba(0, 0, 0, .85), line: "#3a3a3a", lineStrong: "#ffffff", lineFocus: "#ffffff",
            txt: "#ffffff", dim: "#c8c8c8", mut: "#8a8a8a", inverse: "#000000",
            ok: "#ffffff", okBg: "#000000", okLine: "#ffffff",
            warn: "#ffffff", warnBg: "#000000", warnLine: "#ffffff",
            err: "#ffffff", errBg: "#000000", errLine: "#ffffff",
            langPy: "#ffffff", langRs: "#ffffff", langJs: "#ffffff", langJava: "#ffffff", langC: "#ffffff", langDefault: "#ffffff",
            shadow1: "transparent", shadow2: "transparent",
            texture: "", accent: "#ffffff", glow: "transparent", glowRadius: 0
        },
        "terminal": {
            bg: "#141414", panel: "#181818", surface: "#1b1b1b", surfaceRaised: "#232323", surfaceSunken: "#101010",
            overlay: rgba(0, 0, 0, .75), line: "#262626", lineStrong: "#3a3a3a", lineFocus: "#d0d0d0",
            txt: "#ebe9e5", dim: "#a8a49d", mut: "#8a867e", inverse: "#141414",
            ok: "#8ccf7e", okBg: "#12261a", okLine: "#2f5c3a",
            warn: "#e5c07b", warnBg: "#262011", warnLine: "#6b5a2a",
            err: "#f07878", errBg: "#2c1414", errLine: "#6e2c2c",
            langPy: "#8fb4ff", langRs: "#e8a06b", langJs: "#e5c07b", langJava: "#f07878", langC: "#b69cf0", langDefault: "#a8a49d",
            shadow1: rgba(0, 0, 0, .55), shadow2: rgba(0, 0, 0, .8),
            texture: "", accent: "#e4e4e4", glow: "transparent", glowRadius: 0
        },
        "pixel": {
            bg: "#0a0d12", panel: "#0d1117", surface: "#0d1117", surfaceRaised: "#161b22", surfaceSunken: "#070a0e",
            overlay: rgba(1, 4, 9, .82), line: "#21262d", lineStrong: "#30363d", lineFocus: "#79c0ff",
            txt: "#e6edf3", dim: "#9da7b3", mut: "#7d8590", inverse: "#0a0d12",
            ok: "#56d364", okBg: "#0f2417", okLine: "#2ea043",
            warn: "#e3b341", warnBg: "#261d08", warnLine: "#9e6a03",
            err: "#ff7b72", errBg: "#2d1113", errLine: "#a3302b",
            langPy: "#79c0ff", langRs: "#ffa657", langJs: "#e3b341", langJava: "#ff7b72", langC: "#bc8cff", langDefault: "#9da7b3",
            shadow1: rgba(0, 0, 0, .55), shadow2: rgba(0, 0, 0, .8),
            texture: "stars", accent: "#56d364", glow: rgba(86, 211, 100, .45), glowRadius: 8
        }
    })

    readonly property var p: palettes[current] || palettes[T.DEFAULT_THEME]

    readonly property color bg: p.bg
    readonly property color panel: p.panel
    readonly property color surface: p.surface
    readonly property color surfaceRaised: p.surfaceRaised
    readonly property color surfaceSunken: p.surfaceSunken
    readonly property color overlay: p.overlay
    readonly property color line: p.line
    readonly property color lineStrong: p.lineStrong
    readonly property color lineFocus: p.lineFocus
    readonly property color txt: p.txt
    readonly property color dim: p.dim
    readonly property color mut: p.mut
    readonly property color inverse: p.inverse
    readonly property color ok: p.ok
    readonly property color okBg: p.okBg
    readonly property color okLine: p.okLine
    readonly property color warn: p.warn
    readonly property color warnBg: p.warnBg
    readonly property color warnLine: p.warnLine
    readonly property color err: p.err
    readonly property color errBg: p.errBg
    readonly property color errLine: p.errLine
    readonly property color langPy: p.langPy
    readonly property color langRs: p.langRs
    readonly property color langJs: p.langJs
    readonly property color langJava: p.langJava
    readonly property color langC: p.langC
    readonly property color langDefault: p.langDefault
    readonly property color shadow1: p.shadow1
    readonly property color shadow2: p.shadow2
    readonly property color accent: p.accent
    readonly property bool hasShadow: current !== "contrast"
    // Glow (text-shadow on the status line and active step) goes with decor.
    readonly property color glow: decor ? p.glow : "transparent"
    readonly property int glowRadius: decor ? p.glowRadius : 0
    readonly property bool hasGlow: decor && p.glowRadius > 0

    /** The colour a language mark uses: py, rs, js, java, c, anything else. */
    function langColor(lang) {
        switch (String(lang || "").toLowerCase()) {
        case "py": case "python": return langPy
        case "rs": case "rust": return langRs
        case "js": case "ts": case "javascript": case "typescript": return langJs
        case "java": return langJava
        case "c": case "cpp": case "c++": return langC
        default: return langDefault
        }
    }

    // Terminal draws its active marks and the invert button in the accent.
    readonly property color activeMark: isTerminal ? accent : (isPixel ? pxG2 : txt)
    readonly property color invertBg: isTerminal ? accent : (isPixel ? pxG2 : txt)

    // ---- Texture --------------------------------------------------------
    // Static tiles drawn once by an Image in Tile mode (see components/Texture.qml).
    readonly property string texture: decor ? p.texture : ""
    function asset(name) { return Qt.resolvedUrl("../assets/" + name + ".png") }

    // ---- Pixel's own tokens -----------------------------------------------
    readonly property color pxG1: "#aff5b4"
    readonly property color pxG2: "#56d364"
    readonly property color pxG3: "#2ea043"
    readonly property color pxG4: "#196c2e"
    readonly property color pxBlue: "#79c0ff"
    readonly property color pxPurple: "#bc8cff"
    readonly property color pxAmber: "#e3b341"
    readonly property color pxRed: "#ff7b72"
    readonly property color pxShadow: "#010409"
    readonly property color pxChrome: "#30363d"
    // Pixel's rail cards and step cards cycle their 3px top border.
    function pxCycle(i) { return [pxG2, pxBlue, pxPurple, pxAmber, pxRed][i % 5] }
}
