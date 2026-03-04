import * as vscode from "vscode";
import { CharacterManager, CharacterData } from "./characterManager";

/**
 * Manages the webview panel that renders the virtual office.
 */
export class OfficePanel {
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private _onDidDispose = new vscode.EventEmitter<void>();
  public readonly onDidDispose = this._onDidDispose.event;

  constructor(
    private context: vscode.ExtensionContext,
    private characterManager: CharacterManager
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "teamsPixelAgents.office",
      "Teams Pixel Office",
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "webview-ui", "dist"),
          vscode.Uri.joinPath(context.extensionUri, "webview-ui", "public"),
        ],
      }
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this.disposables
    );

    this.updateContent();
  }

  reveal() {
    this.panel.reveal();
  }

  refreshCharacters() {
    const characters = this.characterManager.getAllCharacters();
    this.panel.webview.postMessage({
      type: "characters-updated",
      characters,
    });
  }

  dispose() {
    this.panel.dispose();
    this.disposables.forEach((d) => d.dispose());
    this._onDidDispose.fire();
  }

  private handleMessage(msg: { type: string; [key: string]: unknown }) {
    switch (msg.type) {
      case "ready":
        this.refreshCharacters();
        break;
      case "remove-character":
        if (typeof msg.id === "string") {
          this.characterManager.removeCustomCharacter(msg.id);
          this.refreshCharacters();
        }
        break;
    }
  }

  private updateContent() {
    const webview = this.panel.webview;

    // Check if webview-ui has been built
    const distUri = vscode.Uri.joinPath(
      this.context.extensionUri,
      "webview-ui",
      "dist"
    );

    // Use inline HTML for development (no build step required to get started)
    webview.html = this.getDevHtml(webview);
  }

  /**
   * Self-contained HTML with the office renderer.
   * This works without building the webview-ui — great for quick development.
   */
  private getDevHtml(webview: vscode.Webview): string {
    const nonce = getNonce();

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             img-src ${webview.cspSource} data:;
             style-src ${webview.cspSource} 'nonce-${nonce}';
             script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Teams Pixel Office</title>
  <style nonce="${nonce}">
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #1B1A2E;
      overflow: hidden;
      font-family: 'Segoe UI', system-ui, sans-serif;
    }
    #office-canvas {
      display: block;
      width: 100vw;
      height: 100vh;
      image-rendering: pixelated;
    }
    #hud {
      position: fixed;
      top: 12px;
      left: 12px;
      color: #C8C6C4;
      font-size: 12px;
      pointer-events: none;
      z-index: 10;
    }
    #hud h1 {
      font-size: 14px;
      color: #6264A7;
      margin-bottom: 4px;
    }
    #character-panel {
      position: fixed;
      top: 12px;
      right: 12px;
      background: rgba(27, 26, 46, 0.9);
      border: 1px solid #6264A7;
      border-radius: 8px;
      padding: 12px;
      color: #C8C6C4;
      font-size: 12px;
      max-height: 80vh;
      overflow-y: auto;
      z-index: 10;
    }
    #character-panel h2 {
      font-size: 13px;
      color: #7F85F5;
      margin-bottom: 8px;
    }
    .char-item {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
      padding: 4px;
      border-radius: 4px;
      cursor: default;
    }
    .char-item:hover { background: rgba(98, 100, 167, 0.2); }
    .char-avatar {
      width: 32px;
      height: 32px;
      border-radius: 4px;
      object-fit: cover;
      image-rendering: pixelated;
    }
    .char-name { flex: 1; }
    .char-status {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #4CAF50;
    }
  </style>
</head>
<body>
  <div id="hud">
    <h1>Teams Pixel Office</h1>
    <span id="fps-counter">-- fps</span>
  </div>
  <div id="character-panel">
    <h2>Characters</h2>
    <div id="char-list">Loading...</div>
  </div>
  <canvas id="office-canvas"></canvas>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // ───── Constants ─────
    const TILE = 32;
    const TEAMS_PURPLE = '#6264A7';
    const TEAMS_DARK = '#1B1A2E';
    const TEAMS_LIGHT = '#2D2C42';
    const FLOOR_COLOR = '#252440';
    const WALL_COLOR = '#3B3966';
    const DESK_COLOR = '#4A4870';

    // ───── State ─────
    let characters = [];
    let agents = []; // Active agents on the canvas
    const canvas = document.getElementById('office-canvas');
    const ctx = canvas.getContext('2d');
    let lastTime = 0;
    let frameCount = 0;
    let fpsTime = 0;

    // ───── Office Layout (tile grid) ─────
    // 0 = floor, 1 = wall, 2 = desk, 3 = plant, 4 = monitor
    const OFFICE_W = 20;
    const OFFICE_H = 14;
    const office = [];
    for (let y = 0; y < OFFICE_H; y++) {
      office[y] = [];
      for (let x = 0; x < OFFICE_W; x++) {
        // Walls on border
        if (y === 0 || y === OFFICE_H - 1 || x === 0 || x === OFFICE_W - 1) {
          office[y][x] = 1;
        }
        // Desks in rows
        else if ((y === 4 || y === 9) && x >= 3 && x <= 16 && x % 3 === 0) {
          office[y][x] = 2;
        }
        // Plants in corners
        else if ((y === 2 && (x === 2 || x === 17)) || (y === 11 && (x === 2 || x === 17))) {
          office[y][x] = 3;
        }
        // Monitors on desks
        else if ((y === 3 || y === 8) && x >= 3 && x <= 16 && x % 3 === 0) {
          office[y][x] = 4;
        }
        else {
          office[y][x] = 0;
        }
      }
    }

    // ───── Resize ─────
    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
    window.addEventListener('resize', resize);
    resize();

    // ───── Agent class ─────
    class Agent {
      constructor(charData, startX, startY) {
        this.char = charData;
        this.x = startX * TILE;
        this.y = startY * TILE;
        this.targetX = this.x;
        this.targetY = this.y;
        this.speed = 60 + Math.random() * 40; // pixels per second
        this.state = 'idle';
        this.stateTimer = 0;
        this.idleDuration = 2 + Math.random() * 3;
        this.direction = 1; // 1 = right, -1 = left
        this.bobOffset = 0;
        this.bobTimer = 0;
        this.speechBubble = '';
        this.speechTimer = 0;
        this.image = null;

        // Load character image
        this.loadImage();
      }

      loadImage() {
        const img = new Image();
        const mime = this.char.mimeType || 'image/png';
        if (mime === 'image/svg+xml') {
          img.src = 'data:' + mime + ';base64,' + this.char.imageData;
        } else {
          img.src = 'data:' + mime + ';base64,' + this.char.imageData;
        }
        img.onload = () => { this.image = img; };
      }

      update(dt) {
        this.bobTimer += dt * 4;
        this.bobOffset = Math.sin(this.bobTimer) * 2;

        if (this.speechTimer > 0) {
          this.speechTimer -= dt;
        }

        switch (this.state) {
          case 'idle':
            this.stateTimer += dt;
            if (this.stateTimer > this.idleDuration) {
              this.pickNewTarget();
              this.state = 'walking';
              this.stateTimer = 0;
            }
            break;

          case 'walking':
            const dx = this.targetX - this.x;
            const dy = this.targetY - this.y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < 2) {
              this.x = this.targetX;
              this.y = this.targetY;
              this.state = 'idle';
              this.idleDuration = 2 + Math.random() * 4;
              this.stateTimer = 0;

              // Occasionally show a speech bubble
              if (Math.random() < 0.3) {
                const bubbles = ['Working...', 'In a meeting', 'Coding!', 'BRB', 'Shipping it!', 'LGTM', '🚀'];
                this.speechBubble = bubbles[Math.floor(Math.random() * bubbles.length)];
                this.speechTimer = 2;
              }
            } else {
              const moveX = (dx / dist) * this.speed * dt;
              const moveY = (dy / dist) * this.speed * dt;
              this.x += moveX;
              this.y += moveY;
              this.direction = dx > 0 ? 1 : -1;
            }
            break;
        }
      }

      pickNewTarget() {
        // Pick a random walkable tile
        let attempts = 0;
        while (attempts < 50) {
          const tx = 1 + Math.floor(Math.random() * (OFFICE_W - 2));
          const ty = 1 + Math.floor(Math.random() * (OFFICE_H - 2));
          if (office[ty][tx] === 0) {
            this.targetX = tx * TILE;
            this.targetY = ty * TILE;
            return;
          }
          attempts++;
        }
      }

      draw(ctx, offsetX, offsetY) {
        const drawX = offsetX + this.x;
        const drawY = offsetY + this.y + this.bobOffset;

        // Shadow
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.ellipse(drawX + TILE / 2, drawY + TILE - 2, 12, 4, 0, 0, Math.PI * 2);
        ctx.fill();

        // Character image
        if (this.image) {
          ctx.save();
          if (this.direction === -1) {
            ctx.translate(drawX + TILE, drawY);
            ctx.scale(-1, 1);
            ctx.drawImage(this.image, 0, 0, TILE, TILE);
          } else {
            ctx.drawImage(this.image, drawX, drawY, TILE, TILE);
          }
          ctx.restore();
        } else {
          // Fallback colored square
          ctx.fillStyle = TEAMS_PURPLE;
          ctx.fillRect(drawX + 4, drawY + 4, TILE - 8, TILE - 8);
        }

        // Name label
        ctx.fillStyle = '#C8C6C4';
        ctx.font = '10px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(this.char.name, drawX + TILE / 2, drawY - 4);

        // Walking indicator
        if (this.state === 'walking') {
          ctx.fillStyle = '#7F85F5';
          ctx.beginPath();
          ctx.arc(drawX + TILE / 2, drawY - 12, 3, 0, Math.PI * 2);
          ctx.fill();
        }

        // Speech bubble
        if (this.speechTimer > 0 && this.speechBubble) {
          const bubbleX = drawX + TILE / 2;
          const bubbleY = drawY - 24;
          ctx.font = '10px "Segoe UI", sans-serif';
          const textW = ctx.measureText(this.speechBubble).width;
          const pad = 6;

          ctx.fillStyle = 'rgba(255,255,255,0.95)';
          ctx.beginPath();
          ctx.roundRect(bubbleX - textW / 2 - pad, bubbleY - 12, textW + pad * 2, 18, 6);
          ctx.fill();

          ctx.fillStyle = '#252440';
          ctx.textAlign = 'center';
          ctx.fillText(this.speechBubble, bubbleX, bubbleY + 1);
        }
      }
    }

    // ───── Drawing functions ─────
    function drawTile(x, y, type, offsetX, offsetY) {
      const px = offsetX + x * TILE;
      const py = offsetY + y * TILE;

      switch (type) {
        case 0: // Floor
          ctx.fillStyle = FLOOR_COLOR;
          ctx.fillRect(px, py, TILE, TILE);
          // Subtle grid line
          ctx.strokeStyle = 'rgba(255,255,255,0.03)';
          ctx.strokeRect(px, py, TILE, TILE);
          break;

        case 1: // Wall
          ctx.fillStyle = WALL_COLOR;
          ctx.fillRect(px, py, TILE, TILE);
          ctx.fillStyle = 'rgba(98, 100, 167, 0.3)';
          ctx.fillRect(px, py, TILE, 3);
          break;

        case 2: // Desk
          ctx.fillStyle = FLOOR_COLOR;
          ctx.fillRect(px, py, TILE, TILE);
          ctx.fillStyle = DESK_COLOR;
          ctx.fillRect(px + 2, py + 6, TILE - 4, TILE - 10);
          ctx.fillStyle = 'rgba(255,255,255,0.05)';
          ctx.fillRect(px + 2, py + 6, TILE - 4, 2);
          break;

        case 3: // Plant
          ctx.fillStyle = FLOOR_COLOR;
          ctx.fillRect(px, py, TILE, TILE);
          // Pot
          ctx.fillStyle = '#8B6914';
          ctx.fillRect(px + 10, py + 20, 12, 10);
          // Leaves
          ctx.fillStyle = '#4CAF50';
          ctx.beginPath();
          ctx.arc(px + 16, py + 14, 10, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = '#66BB6A';
          ctx.beginPath();
          ctx.arc(px + 13, py + 11, 6, 0, Math.PI * 2);
          ctx.fill();
          break;

        case 4: // Monitor
          ctx.fillStyle = FLOOR_COLOR;
          ctx.fillRect(px, py, TILE, TILE);
          // Screen
          ctx.fillStyle = '#2D2C42';
          ctx.fillRect(px + 6, py + 4, 20, 14);
          // Screen glow
          ctx.fillStyle = 'rgba(127, 133, 245, 0.4)';
          ctx.fillRect(px + 8, py + 6, 16, 10);
          // Stand
          ctx.fillStyle = '#555';
          ctx.fillRect(px + 14, py + 18, 4, 6);
          ctx.fillRect(px + 10, py + 24, 12, 2);
          break;
      }
    }

    function drawOffice() {
      // Center the office in the viewport
      const officePixelW = OFFICE_W * TILE;
      const officePixelH = OFFICE_H * TILE;
      const offsetX = Math.floor((canvas.width - officePixelW) / 2);
      const offsetY = Math.floor((canvas.height - officePixelH) / 2);

      // Background
      ctx.fillStyle = TEAMS_DARK;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Draw tiles
      for (let y = 0; y < OFFICE_H; y++) {
        for (let x = 0; x < OFFICE_W; x++) {
          drawTile(x, y, office[y][x], offsetX, offsetY);
        }
      }

      // Draw agents (sorted by Y for depth)
      agents.sort((a, b) => a.y - b.y);
      for (const agent of agents) {
        agent.draw(ctx, offsetX, offsetY);
      }
    }

    // ───── Game loop ─────
    function gameLoop(timestamp) {
      const dt = Math.min((timestamp - lastTime) / 1000, 0.1);
      lastTime = timestamp;

      // FPS counter
      frameCount++;
      fpsTime += dt;
      if (fpsTime >= 1) {
        document.getElementById('fps-counter').textContent = frameCount + ' fps';
        frameCount = 0;
        fpsTime = 0;
      }

      // Update agents
      for (const agent of agents) {
        agent.update(dt);
      }

      drawOffice();
      requestAnimationFrame(gameLoop);
    }

    // ───── Character panel ─────
    function updateCharPanel() {
      const list = document.getElementById('char-list');
      if (characters.length === 0) {
        list.innerHTML = '<div style="color:#666">No characters yet</div>';
        return;
      }
      list.innerHTML = characters.map(c => {
        const src = 'data:' + (c.mimeType || 'image/png') + ';base64,' + c.imageData;
        return '<div class="char-item">' +
          '<img class="char-avatar" src="' + src + '" alt="' + c.name + '" />' +
          '<span class="char-name">' + c.name + '</span>' +
          '<div class="char-status"></div>' +
          '</div>';
      }).join('');
    }

    function spawnAgents() {
      agents = [];
      // Find walkable spawn points
      const spawns = [];
      for (let y = 1; y < OFFICE_H - 1; y++) {
        for (let x = 1; x < OFFICE_W - 1; x++) {
          if (office[y][x] === 0) spawns.push({ x, y });
        }
      }

      const maxChars = Math.min(characters.length, 10);
      for (let i = 0; i < maxChars; i++) {
        const spawn = spawns[Math.floor(Math.random() * spawns.length)];
        agents.push(new Agent(characters[i], spawn.x, spawn.y));
      }
    }

    // ───── Message handling from extension ─────
    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'characters-updated':
          characters = msg.characters || [];
          updateCharPanel();
          spawnAgents();
          break;
      }
    });

    // ───── Init ─────
    requestAnimationFrame(gameLoop);
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
