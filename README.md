# Agentic Office UX

> Your AI agents deserve an office too.

A living, animated office inside VS Code where your Claude Code agents work, play, and collaborate — with real-time Microsoft Teams integration to keep you connected to your team.

![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.85.0-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue)
![Claude Code](https://img.shields.io/badge/Claude%20Code-Integrated-blueviolet)
![Teams](https://img.shields.io/badge/Microsoft%20Teams-Connected-6264A7)


![Agent office ](https://github.com/user-attachments/assets/bd4970d4-fc8e-4c7a-8b70-eb231c47382a)

---

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                                                                              ║
║   ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐            ║
║   │   BREAK ROOM    │  │     OFFICE      │  │    LIBRARY      │            ║
║   │                 │  │                 │  │                 │            ║
║   │  ☕  🎮         │  │  💻    💻       │  │  📚    📖      │            ║
║   │     ╭───────╮   │  │  ╭──╮  ╭──╮    │  │     ╭──╮       │            ║
║   │     │ Agent │   │  │  │🟢│  │🟡│    │  │     │🔵│       │            ║
║   │     │  idle │   │  │  ╰──╯  ╰──╯    │  │     ╰──╯       │            ║
║   │     ╰───────╯   │  │ "Writing code"  │  │  "Reading..."  │            ║
║   │                 │  │ ···particles···  │  │                 │            ║
║   └─────────────────┘  └─────────────────┘  └─────────────────┘            ║
║                                                                              ║
║   ╭─────────────────────────────────────────╮                               ║
║   │ 📩 Manager: "Hey, can you check the    │  ← Teams message bubble      ║
║   │    deployment status?"                  │                               ║
║   ╰─────────────────────────────────────────╯                               ║
║                                                                              ║
║   Agent A finishes → "Ship it!" 🎉          Agent B: *gets hit by          ║
║                       ~~throws paper~~  ───►  paper ball* "Hey!"           ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

---

## What It Does

Agentic Office UX renders a pixel-art office scene in your VS Code panel with three rooms. When you launch Claude Code agents, each is represented by a unique animated character that moves between rooms in real time based on what the agent is doing.

### The Office

| Room | Who's There | Activities |
|------|-------------|------------|
| Break Room | Unspawned characters, mini-games | Idle, Tic-Tac-Toe |
| Office | Agents actively coding | Thinking, writing, running commands |
| Library | Agents researching or reading | Reading files, searching, MCP calls, waiting for input |

### Activity Tracking

The extension monitors Claude Code's JSONL transcript files and maps tool usage to visual activities:

| Tool | Activity | Visual |
|------|----------|--------|
| `Write`, `Edit` | Writing code | Green glow + particles |
| `Read` | Reading file | Blue glow |
| `Bash` | Running command | Orange glow + particles |
| `Glob`, `Grep` | Searching | Purple orbiting dots |
| `WebSearch`, `WebFetch`, MCP | Researching | Pink glow |
| Thinking blocks | Thinking | Yellow thought bubbles |
| HITL (approval needed) | Waiting for input | Cyan pulsing dots |

Characters display **speech bubbles** with Claude's current thoughts and tool details.

### Playful Idle Behaviors

When an agent finishes a task, it doesn't just sit quietly:
- **Witty quips** — "Ship it!", "Compiled on the first try. Naturally.", "Works on my machine."
- **Paper ball throws** — Animated projectile arcs toward a coworker, who reacts with "Hey!" or "Rude!"

### Microsoft Teams Integration

Stay connected to your team without leaving VS Code. The Teams bot character monitors your manager's 1:1 chat and surfaces messages directly in the office:

- **Live message bubbles** — New messages from your manager appear as speech bubbles above the Teams bot character
- **Badge notifications** — Unread message count shown as a pulsing badge
- **Click to open** — Click a message bubble to jump straight to the Teams chat
- **Smart summarization** — Messages are summarized via Claude Haiku so you get the gist at a glance
- **VS Code notifications** — Important messages also appear as native VS Code notifications with an "Open Chat" action

#### Connecting to Teams

1. Open the command palette → `Teams Pixel Agents: Connect to Teams`
2. Paste a Microsoft Graph API token with these scopes: `Chat.Read`, `User.Read`, `User.Read.All`
3. The Teams bot character in the Break Room will show a green "Monitoring" status
4. Messages from your manager's 1:1 chat are polled at a configurable interval (default: 60s)

> **Note:** The `Chat.Read` scope requires admin consent in most organizations. Contact your tenant admin if you cannot grant this permission in Graph Explorer.

---

## Getting Started

### Prerequisites

- VS Code 1.85.0+
- Node.js 18+
- Claude Code CLI installed (`claude` command available)
- *(Optional)* Microsoft Graph API token for Teams integration
- *(Optional)* Anthropic API key for message summarization

### Install & Run

```bash
npm install
npm run build

# Press F5 in VS Code to launch Extension Development Host
```

The **Agent Office** panel appears automatically in your VS Code bottom panel area.

### Usage

1. **Add characters** — Command palette: `Teams Pixel Agents: Add Custom Character` (or use the 5 built-in characters)
2. **Spawn an agent** — Click any character in the Break Room → choose "Start Working"
3. **Play a game** — Click a character → choose "Play Tic-Tac-Toe" for a quick break
4. **Watch them work** — Characters walk to the Office or Library based on agent activity
5. **Click an active agent** — Opens its Claude Code terminal
6. **Connect Teams** — Command palette: `Teams Pixel Agents: Connect to Teams`

---

## Architecture

```
src/
├── extension.ts          # Activation, commands, event wiring
├── characterManager.ts   # Built-in + custom character data (SVG generation, persistence)
├── claudeWatcher.ts      # Monitors Claude Code JSONL transcripts for activity
├── officePanel.ts        # Webview: canvas rendering, rooms, sprites, interactions
├── teamsWatcher.ts       # Microsoft Graph API polling for Teams messages
└── teamsSummarizer.ts    # Claude Haiku-powered message summarization
```

### Rendering Pipeline

The office scene is rendered on a `<canvas>` element with a `requestAnimationFrame` game loop:

1. **Responsive layout** — Rooms scale to fill the panel (horizontal if wide, vertical if narrow)
2. **Procedural rooms** — Floors (wood planks / carpet), walls, furniture drawn with canvas primitives
3. **Layered character sprites** — Body + hair + outfit composited at load time into 5 unique characters with directional walk animation (6 frames x 4 directions)
4. **DPR-aware** — Canvas scales to `devicePixelRatio` for sharp HiDPI rendering
5. **Pixel-perfect** — `imageSmoothingEnabled = false` for crisp 32x32 sprite upscaling

### Claude Code Integration

`ClaudeWatcher` monitors `~/.claude/projects/` for JSONL transcript files:

- Parses `assistant` message blocks for `tool_use`, `tool_result`, and `thinking` content
- Maps tool names to activity states via `toolToActivity()`
- Detects HITL moments when tool approval takes too long
- Extracts and rotates thought snippets from thinking blocks
- Fires `onAgentActivity` events consumed by the webview to animate characters

### Teams Integration

`TeamsWatcher` polls the Microsoft Graph API for manager messages:

- Resolves your manager via `/me/manager`
- Finds the 1:1 chat via `/me/chats` with member matching
- Polls `/me/chats/{id}/messages` for new messages
- Handles token expiry (401) with reconnect prompt and rate limiting (429) with exponential backoff
- `TeamsSummarizer` uses Claude Haiku to generate concise message summaries

---

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `teamsPixelAgents.maxCharacters` | `5` | Maximum characters in the office |
| `teamsPixelAgents.animationSpeed` | `1` | Animation speed multiplier (0.5 = slow, 2 = fast) |
| `teamsPixelAgents.teamsPollingInterval` | `60` | Seconds between Teams message polls (min: 30) |
| `teamsPixelAgents.anthropicApiKey` | `""` | Claude API key for message summarization |

## Commands

| Command | Description |
|---------|-------------|
| `Teams Pixel Agents: Open Office` | Focus the Agent Office panel |
| `Teams Pixel Agents: Add Custom Character` | Add a custom character from an image file |
| `Teams Pixel Agents: Connect to Teams` | Connect to Teams with a Graph API token |
| `Teams Pixel Agents: Disconnect from Teams` | Stop Teams message monitoring |

## Assets

Character sprites from the MetroCity pixel art pack, composited as layers:

```
assets/
├── char-body.png      # 768x192 — 6 skin tones x 24 animation frames (32x32 each)
├── char-hairs.png     # 768x256 — 8 hair styles x 24 frames
├── char-outfit1-5.png # 768x32 each — 5 outfit variations x 24 frames
└── char-shadow.png    # 32x32 — character shadow
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
