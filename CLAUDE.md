# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run

```bash
npm install          # Install dependencies
npm run compile      # Compile TypeScript (plain tsc to out/, no bundler)
npm run watch        # Watch mode for development
npm test             # Run tests (pretest compiles + lints first)
npm run lint         # Lint only
```

### VS Code Extension Development

```bash
code --extensionDevelopmentPath=. --new-window
```

### Release Commands

```bash
npm run release:patch   # bump patch + compile + package .vsix
npm run release:minor   # bump minor + compile + package .vsix
npm run release:major   # bump major + compile + package .vsix
npm run package         # Package .vsix only
npm run publish         # Publish to VS Code marketplace
```

### Knowledge Base Server (not shipped in extension)

```bash
npm run kb:dev          # compile + preprocess docx → SQLite + start Express server
npm run kb:build        # compile + preprocess only (no server)
npm run preprocess      # Preprocess docx into knowledge_base.db (FTS5)
npm run serve           # Start Express search server on the existing DB
```

## Architecture

VS Code extension (`docxreader`, publisher `ShahilKumar`) that renders .docx and .odt files as custom webview editors.

### Two Concerns in One Repo

1. **VS Code Extension** (the main product): Custom editor for `.docx`/`.odt` files with zoom, search, outline, theme toggle, toolbar, and diff support.
2. **Knowledge Base Server** (`src/server/`): Standalone Express + SQLite(FTS5) server that preprocesses a `.docx` into a searchable database with REST API and web UI. Excluded from the VSIX package via `.vscodeignore` — development/internal tool only.

### Call Chain (Extension)

```
extension.ts → custom_editor.ts → render.ts → docx_handler.ts / odt_handler.ts
```

- `src/extension.ts` — `activate()` registers `DocxEditorProvider` and all commands (zoom, outline, theme, toolbar, status bar).
- `src/custom_editor.ts` — `DocxEditorProvider` implements `vscode.CustomEditorProvider`. Per-document state (zoom, outline, theme, toolbar) via `documentStates` Map keyed by URI string. Handles scroll sync across diff views and command dispatch. Contains the LCS-based paragraph diff algorithm.
- `src/render.ts` — `DocumentRenderer` generates the webview HTML. Static methods for HTML generation, outline extraction, search, CSS injection, and postMessage command handling (zoom, theme, outline, toolbar, scroll sync, diff highlighting). **All webview CSS and JS are inline template strings in this file** — there are no separate asset files loaded by the webview.
- `src/docx_handler.ts` — `DocxHandler` converts .docx to HTML via `mammoth`. Handles `file://`, `git://`, and other VS Code URI schemes. Falls back to `workspace.fs.readFile`. Detects Git LFS pointer files.
- `src/odt_handler.ts` — `OdtHandler` converts .odt to HTML via `odt2html`. Writes to temp file if URI is not `file://` scheme.
- `src/styles/viewer.css` — Legacy/reference stylesheet, not loaded by the extension at runtime (CSS is inlined in `render.ts`).

### Knowledge Base Server (`src/server/`)

- `config.ts` — Config loader reading from `docx-viewer.config.json` and CLI args.
- `preprocessor.ts` — Parses `.docx` into SQLite FTS5 search index (`knowledge_base.db`).
- `search_server.ts` — Express server with REST endpoints (`/api/search`, `/api/section/:id`, `/api/outline`, `/api/stats`, `/api/qa`, `/api/chat`).
- `chat_handler.ts` — Chat endpoint handler.
- `web/` — Static frontend (HTML, JS, CSS) served by Express.

### Data Flow
1. User opens `.docx`/`.odt` → VS Code routes to `DocxEditorProvider.openCustomDocument()`
2. `resolveCustomEditor()` calls `DocumentRenderer.renderDocument()`
3. `DocumentRenderer` dispatches to `DocxHandler` or `OdtHandler` to get HTML
4. `generateEnhancedHtml()` wraps HTML in a full webview page with toolbar, outline, CSS, and JS
5. Webview JS posts messages back → `handleWebviewMessage()` updates state and renderer

### Per-Document State
Each document has independent `DocumentState` (zoom, outline visibility, theme, toolbar visibility). `documentStates` keyed by URI string. `panelsByPath` tracks multiple panels of the same file for scroll sync and diff highlighting.

### Theme System
Config `docxreader.theme` takes precedence over runtime toggle state (fixes #27). Theme drives CSS variables on the webview body (`vscode-dark`, `vscode-high-contrast` classes). Uses `!important` CSS overrides and a `MutationObserver` to override VS Code's injected body classes — this was a multi-iteration fix (#25, #27), so changes here need careful testing.

### Diff View Support
When 2+ panels exist for the same `fsPath` (git diff scenario), `triggerDiffUpdate()` uses LCS-based diff to compare paragraph text and sends `highlight` messages to colorize changes.

### Extension Settings
- `docxreader.font` — Font family (default: `Arial`)
- `docxreader.theme` — `auto` | `light` | `dark` (default: `auto`, config takes precedence over system theme)
- `docxreader.zoomLevel` — 0.5–3.0 (default: `1.0`)
- `docxreader.showOutline` — Show outline by default (default: `true`)

## Code Style

- TypeScript strict mode, target ES2022, module Node16
- ESLint flat config (`eslint.config.js`): single quotes, semicolons required, `prefer-const`, `no-var`, `eqeqeq`, `curly`, 1tbs brace style, `_` prefix suppresses unused-var warnings
- Legacy `.eslintrc.json` also exists but `eslint.config.js` is the active config for ESLint 9+
- No bundler — plain `tsc` compiles `src/` to `out/`

## Testing

Integration tests via `@vscode/test-electron` + Mocha (TDD style: `suite`/`test`). Tests require a full VS Code instance — no standalone unit test runner. Run with `npm test`. Test files in `src/test/suite/*.test.ts`.
