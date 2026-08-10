<div align="center">

<img src="build/icon.png" alt="CloseNI" width="120">

# CloseNI

**A desktop agent that turns web-based AI chats into an automated build pipeline — zero API keys required.**

`Electron` · `TypeScript` · `Playwright` · `No API Keys` · `Cross-Platform`

</div>

---

## ⚡ What is CloseNI?

CloseNI automates browser sessions with leading AI models (DeepSeek, Qwen, GLM). It interacts with chat DOMs directly to send prompts, parse code responses, apply workspace patches, syntax check code changes, and heal build errors autonomously.

```
   YOU                CloseNI                  CHAT SITE               YOUR DISK
    │                    │                          │                      │
    │  "build me a       │                          │                      │
    │   flask todo api"  │                          │                      │
    ├───────────────────►│                          │                      │
    │                    │   plan this, as JSON     │                      │
    │                    ├─────────────────────────►│                      │
    │                    │◄─────────────────────────┤                      │
    │   ┌─────────────┐  │   6 steps, a run command │                      │
    │◄──┤ review plan │  │                          │                      │
    │   └─────────────┘  │                          │                      │
    │      approve       │                          │                      │
    ├───────────────────►│   step 1 …               │                      │
    │                    ├─────────────────────────►│                      │
    │                    │◄─────────────────────────┤                      │
    │                    │   {"files":[…]}          │                      │
    │                    ├──────────────────────────┼─────────────────────►│
    │                    │   apply, syntax check    │       files written  │
    │                    │                          │                      │
    │                    │   step 2 & 3 (parallel)  │                      │
    │                    ├═════════════════════════►│                      │
```

---

## ✨ Features

- **Zero API Keys**: Operates via persistent Playwright browser sessions using your existing accounts.
- **Dynamic Task Planning**: Generates step-by-step execution plans scaled to project complexity.
- **Parallel Step Execution**: Runs non-dependent tasks concurrently across isolated chat tabs.
- **Self-Healing Build Pipeline**: Automatically captures compiler/linter errors and re-prompts the model to fix issues.
- **Multi-Language Verification**: Supports Rust (`cargo`), C/C++ (`make`/`gcc`/`g++`), Java (`mvn`/`gradle`), Python, and Node.js.
- **Self-Running Projects**: Generates `closeni.run.json` along with `run.sh` / `run.bat` scripts for execution.
- **Customizable UI Themes**: Includes 9 built-in themes (including retro CRT modes and high-contrast fallbacks).

---

## 🏗️ Architecture

CloseNI separates the UI renderer from the agent logic for security and stability:

```mermaid
flowchart TB
    subgraph desktop["desktop/ — Electron App"]
        R["renderer.js<br/>Panels, Plans, Diffs"]
        B["builder.js<br/>Step Scheduler"]
        M["main.js<br/>IPC, Git, Credentials"]
        R <--> M
        B <--> M
    end

    subgraph agent["local-agent/ — TypeScript CLI"]
        C["PlaywrightController<br/>Send · Wait · Extract"]
        P["Parser<br/>JSON Repair"]
        A["Patch Applier<br/>Backups & Containment"]
        V["Verification Planner<br/>Syntax & Linter Checks"]
        C --> P --> A --> V
    end

    subgraph web["Web Browser Sessions"]
        D["DeepSeek"]
        Q["Qwen"]
        G["GLM"]
    end

    M -->|"Spawn CLI"| C
    C --> D
    C --> Q
    C --> G
    A -->|"Apply Patch"| W[("Workspace")]
```

---

## 🚀 Quickstart

```bash
# 1. Install dependencies & build core agent
npm install
npm run build

# 2. Install Playwright Chromium browser
npx playwright install chromium

# 3. Launch desktop app
cd desktop && npm start
```

### Usage Steps:
1. **Workspace**: Select your project folder.
2. **Settings**: Choose a provider and sign in to your browser session.
3. **Chat**: Describe what you want built.
4. **Build**: Review the generated plan and click **Build**.
5. **Test**: Run your application directly from the **Test** tab.

#### WSL Setup
```bash
source scripts/wsl-env.sh
```

---

## 🛠️ Supported Languages & Build Tools

| Language / Framework | Manifest Check | Standalone Check |
|---|---|---|
| **Rust** | `Cargo.toml` (`cargo check`) | `rustc --emit=metadata` |
| **C / C++** | `Makefile` (`make -n`) | `gcc -fsyntax-only` / `g++ -fsyntax-only` |
| **Java** | `pom.xml` / `build.gradle` | `javac` |
| **Python** | — | `python -m py_compile` |
| **JavaScript / TS** | — | `node --check` |

---

## 🧪 Testing

```bash
# Unit tests
node local-agent/test/run-tests.cjs

# End-to-end integration tests
node local-agent/test/run-e2e.cjs
```

---

## 📦 Packaging & Building Installers

```bash
# Build unpacked distribution
npm run pack

# Create platform installer (.exe / .deb / AppImage)
npm run dist
```

---

## 📂 Project Structure

```
desktop/          Electron main process, preload, and UI renderer
local-agent/      Playwright controller, DOM parser, patch applier, and verification
shared/           Shared TypeScript data types and schemas
build/            Icons and branding assets
docs/             Architecture design specs and implementation plans
scripts/          Environment initialization and automation helpers
```
