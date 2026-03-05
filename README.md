# Teams Pixel Agents

Animated pixel characters in a virtual office inside VS Code — watch your Claude Code agents come to life!

![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85.0-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)

## What It Does

Teams Pixel Agents renders a pixel-art office scene in your VS Code panel with three rooms — a **Break Room**, an **Office**, and a **Library**. When you launch Claude Code agents, each one is represented by a unique animated character that moves between rooms based on what the agent is doing in real time.

### Rooms

| Room | Who's There | Activities |
|------|-------------|------------|
| Break Room | Unspawned characters waiting to be activated | idle / not yet started |
| Office | Agents actively coding | thinking, writing, running commands |
| Library | Agents researching or reading | reading files, searching, MCP calls, waiting for input |

### Activity Tracking

The extension monitors Claude Code's JSONL transcript files and maps tool usage to visual activities:

| Tool | Activity | Visual |
|------|----------|--------|
| `Write`, `Edit` | Writing code | Green glow + particles |
| `Read` | Reading file | Blue glow |
| `Bash` | Running command | Orange glow + particles |
| `Glob`, `Grep` | Searching | Purple orbiting dots |
| `WebSearch`, `WebFetch`, MCP tools | Researching (MCP call) | Pink glow |
| Thinking blocks | Thinking | Yellow thought bubbles |
| HITL (approval needed) | Waiting for input | Cyan pulsing dots |

Characters also display **speech bubbles** with Claude's current thoughts and tool details.

## Getting Started

### Prerequisites

- VS Code 1.85.0+
- Node.js 18+
- Claude Code CLI installed (`claude` command available)

### Install & Run

```bash
# Install dependencies
npm install

# Build the extension
npm run build

# Launch in VS Code
# Press F5 to open Extension Development Host
```

The **Pixel Office** panel appears automatically in your VS Code bottom panel area.

### Usage

1. **Add characters** — Use the command palette: `Teams Pixel Agents: Add Custom Character` (or use the 5 built-in characters)
2. **Spawn an agent** — Click any character in the Break Room to launch a Claude Code terminal session
3. **Watch them work** — Characters walk to the Office or Library based on what the agent is doing
4. **Click an active agent** — Brings up its Claude Code terminal

## Architecture

```
src/
├── extension.ts          # Activation, commands, event wiring
├── characterManager.ts   # Built-in + custom character data (SVG generation, persistence)
├── claudeWatcher.ts      # Monitors Claude Code JSONL transcripts for activity
└── officePanel.ts        # Webview: canvas rendering, procedural rooms, sprite compositing
```

### Rendering Pipeline

The office scene is rendered entirely on a `<canvas>` element with a `requestAnimationFrame` game loop:

1. **Responsive layout** — Rooms scale to fill the panel (horizontal if wide, vertical stack if narrow)
2. **Procedural rooms** — Floors (wood planks / carpet), walls, furniture all drawn with canvas primitives
3. **Layered character sprites** — Uses [MetroCity](https://craftpix.net/) sprite pack: body + hair + outfit composited at load time into 5 unique characters with directional walk animation (6 frames x 4 directions)
4. **DPR-aware** — Canvas backing store scales to `devicePixelRatio` for sharp rendering on HiDPI displays
5. **Pixel-perfect** — `imageSmoothingEnabled = false` for crisp upscaling of 32x32 sprites

### Claude Code Integration

`ClaudeWatcher` monitors `~/.claude/projects/` for JSONL transcript files:

- Parses `assistant` message blocks for `tool_use`, `tool_result`, and `thinking` content
- Maps tool names to activity states via `toolToActivity()`
- Detects HITL (Human-In-The-Loop) moments when tool approval takes too long
- Extracts and rotates thought snippets from thinking blocks
- Fires `onAgentActivity` events that the webview consumes to animate characters

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `teamsPixelAgents.maxCharacters` | `5` | Maximum characters in the office |
| `teamsPixelAgents.animationSpeed` | `1` | Animation speed multiplier (0.5 = slow, 2 = fast) |

## Commands

| Command | Description |
|---------|-------------|
| `Teams Pixel Agents: Open Office` | Focus the Pixel Office panel |
| `Teams Pixel Agents: Add Custom Character` | Add a custom character from an image file (PNG, JPG, GIF, WEBP) |

## Assets

Character sprites are from the MetroCity pixel art pack, composited as layers:

```
assets/
├── char-body.png      # 768x192 — 6 skin tones x 24 animation frames (32x32 each)
├── char-hairs.png     # 768x256 — 8 hair styles x 24 frames
├── char-outfit1-5.png # 768x32 each — 5 outfit variations x 24 frames
├── char-shadow.png    # 32x32 — character shadow
└── spritesheet.png    # Legacy sprite sheet (unused)
```

## Development

```bash
npm run watch    # Watch mode for extension
npm run lint     # Run ESLint
npm run package  # Package .vsix for distribution
```

**Debug:** Press F5 in VS Code, then Ctrl+R in the Extension Development Host to reload the webview after changes.

## License

MIT
