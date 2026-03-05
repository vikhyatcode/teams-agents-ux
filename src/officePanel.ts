import * as vscode from "vscode";
import * as path from "path";
import { CharacterManager } from "./characterManager";
import { ClaudeWatcher } from "./claudeWatcher";

export class OfficePanel implements vscode.WebviewViewProvider {
  public static readonly viewType = "teamsPixelAgents.officeView";

  private view?: vscode.WebviewView;

  constructor(
    private context: vscode.ExtensionContext,
    private characterManager: CharacterManager,
    private claudeWatcher: ClaudeWatcher
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this.view = webviewView;

    const assetsPath = vscode.Uri.joinPath(this.context.extensionUri, "assets");

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [assetsPath],
    };

    webviewView.webview.onDidReceiveMessage((msg) =>
      this.handleMessage(msg)
    );

    webviewView.webview.html = this.getHtml(webviewView.webview);
  }

  postMessage(msg: Record<string, unknown>) {
    this.view?.webview.postMessage(msg);
  }

  refreshCharacters() {
    this.view?.webview.postMessage({
      type: "characters-updated",
      characters: this.characterManager.getAllCharacters(),
    });
  }

  private handleMessage(msg: { type: string; [key: string]: unknown }) {
    switch (msg.type) {
      case "ready":
        this.refreshCharacters();
        break;

      case "spawn-agent": {
        const characterId = msg.characterId as string;
        const agentId = this.claudeWatcher.launchAgent(characterId);
        const allChars = this.characterManager.getAllCharacters();
        const charData = allChars.find((c) => c.id === characterId);
        this.view?.webview.postMessage({
          type: "agent-spawned",
          agentId,
          characterId,
          charData,
        });
        break;
      }

      case "click-agent": {
        const agentId = msg.agentId as string;
        const agent = this.claudeWatcher.getAgent(agentId);
        if (agent?.terminal) {
          agent.terminal.show();
        }
        break;
      }
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const charBodyUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "assets", "char-body.png")
    );
    const charHairsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "assets", "char-hairs.png")
    );
    const charShadowUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "assets", "char-shadow.png")
    );
    const outfitUris = [1, 2, 3, 4, 5].map(i =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "assets", `char-outfit${i}.png`)
      )
    );

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
      background: #1E1E2E;
      overflow: hidden;
      font-family: 'Segoe UI', system-ui, sans-serif;
    }
    #office-canvas {
      display: block;
      width: 100vw;
      height: 100vh;
      cursor: default;
    }
  </style>
</head>
<body>
  <canvas id="office-canvas"></canvas>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // ─── Constants ───
    const CHAR_SIZE = 80;
    const MOVE_SPEED = 90;
    const MAX_AGENTS = 5;
    const ROOM_GAP = 16;

    // MetroCity sprite constants (32x32 frames, 24 cols)
    const MC_FRAME = 32;
    const MC_COLS = 24;
    // Animation layout (24 frames):
    // cols 0-5: walk down (6 frames), cols 6-11: walk left (6),
    // cols 12-17: walk right (6), cols 18-23: walk up (6)
    const MC_ANIM = {
      down:  { start: 0, count: 6 },
      left:  { start: 6, count: 6 },
      right: { start: 12, count: 6 },
      up:    { start: 18, count: 6 },
    };
    // Idle frame = first frame of each direction
    const MC_IDLE_FRAME = 0; // facing down

    // 5 unique character combos: [bodyRow, hairRow, outfitIndex]
    const CHAR_COMBOS = [
      { bodyRow: 0, hairRow: 0, outfit: 0 }, // light skin, dark hair, outfit1
      { bodyRow: 1, hairRow: 2, outfit: 1 }, // medium skin, red hair, outfit2
      { bodyRow: 2, hairRow: 3, outfit: 4 }, // tan skin, orange hair, outfit5
      { bodyRow: 3, hairRow: 5, outfit: 2 }, // brown skin, black hair, outfit3
      { bodyRow: 0, hairRow: 4, outfit: 3 }, // light skin, blonde hair, outfit4
    ];

    // MetroCity sprite URLs
    const MC_BODY_URL = "${charBodyUri}";
    const MC_HAIRS_URL = "${charHairsUri}";
    const MC_SHADOW_URL = "${charShadowUri}";
    const MC_OUTFIT_URLS = [
      "${outfitUris[0]}",
      "${outfitUris[1]}",
      "${outfitUris[2]}",
      "${outfitUris[3]}",
      "${outfitUris[4]}",
    ];

    const ACT_COLORS = {
      idle: '#888', thinking: '#FFB900', writing: '#4CAF50',
      reading: '#2196F3', 'running-command': '#FF6B35', searching: '#9C27B0',
      researching: '#E91E63', waiting: '#00BCD4',
    };
    const ACT_LABELS = {
      idle: 'At desk', thinking: 'Thinking...', writing: 'Writing code',
      reading: 'Reading file', 'running-command': 'Running cmd', searching: 'Searching',
      researching: 'MCP call', waiting: 'Waiting for input',
    };

    // Activity → room: 0=Break, 1=Office, 2=Library
    function activityToRoom(activity) {
      if (activity === 'reading' || activity === 'searching' || activity === 'researching' || activity === 'waiting') return 2;
      return 1;
    }

    // ─── Procedural drawing helpers ───
    function drawWoodPlanks(x, y, w, h, base, line, highlight, plankW) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.fillStyle = base;
      ctx.fillRect(x, y, w, h);
      for (let px = x; px < x + w; px += plankW) {
        // Alternating shade
        if (((px - x) / plankW | 0) % 2 === 0) {
          ctx.fillStyle = highlight;
          ctx.fillRect(px, y, plankW, h);
        }
        ctx.strokeStyle = line;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px, y);
        ctx.lineTo(px, y + h);
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawCarpetPattern(x, y, w, h, base, dot1, dot2, spacing) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.fillStyle = base;
      ctx.fillRect(x, y, w, h);
      for (let dy = 0; dy < h; dy += spacing) {
        for (let dx = 0; dx < w; dx += spacing) {
          ctx.fillStyle = (dx + dy) % (spacing * 2) === 0 ? dot1 : dot2;
          ctx.fillRect(x + dx, y + dy, 2, 2);
        }
      }
      ctx.restore();
    }

    function drawMonitor(mx, my, mw, mh, screenColor, bodyColor, phase) {
      // Stand
      ctx.fillStyle = bodyColor;
      ctx.fillRect(mx + mw / 2 - 3, my + mh, 6, 5);
      ctx.fillRect(mx + mw / 2 - 7, my + mh + 4, 14, 3);
      // Body
      ctx.fillStyle = bodyColor;
      ctx.beginPath();
      ctx.roundRect(mx, my, mw, mh, 2);
      ctx.fill();
      // Screen
      const glow = 0.6 + 0.4 * Math.sin(animTimer * 2 + phase);
      ctx.save();
      ctx.globalAlpha = glow;
      ctx.fillStyle = screenColor;
      ctx.fillRect(mx + 2, my + 2, mw - 4, mh - 4);
      ctx.restore();
      // Screen lines
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      for (let ly = my + 4; ly < my + mh - 4; ly += 3) {
        ctx.fillRect(mx + 4, ly, mw - 8, 1);
      }
    }

    function drawPlant(px, py, scale, potColor, leafColor) {
      const s = scale;
      // Pot
      ctx.fillStyle = potColor;
      ctx.beginPath();
      ctx.moveTo(px - 5 * s, py);
      ctx.lineTo(px + 5 * s, py);
      ctx.lineTo(px + 4 * s, py + 8 * s);
      ctx.lineTo(px - 4 * s, py + 8 * s);
      ctx.closePath();
      ctx.fill();
      // Soil
      ctx.fillStyle = '#3E2723';
      ctx.fillRect(px - 4 * s, py, 8 * s, 2 * s);
      // Leaves
      ctx.fillStyle = leafColor;
      ctx.beginPath();
      ctx.ellipse(px, py - 4 * s, 6 * s, 5 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#2E7D32';
      ctx.beginPath();
      ctx.ellipse(px - 3 * s, py - 6 * s, 4 * s, 3 * s, -0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(px + 3 * s, py - 5 * s, 4 * s, 3 * s, 0.4, 0, Math.PI * 2);
      ctx.fill();
    }

    function drawChair(cx, cy, color) {
      // Wheel bar
      ctx.fillStyle = '#333';
      ctx.fillRect(cx - 8, cy + 18, 16, 2);
      // Wheels
      ctx.fillStyle = '#222';
      ctx.beginPath();
      ctx.arc(cx - 7, cy + 21, 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx + 7, cy + 21, 2, 0, Math.PI * 2);
      ctx.fill();
      // Post
      ctx.fillStyle = '#444';
      ctx.fillRect(cx - 1, cy + 8, 3, 10);
      // Seat
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(cx - 9, cy + 4, 18, 6, 2);
      ctx.fill();
      // Backrest
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(cx - 7, cy - 8, 14, 13, 3);
      ctx.fill();
      // Backrest highlight
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(cx - 5, cy - 6, 10, 2);
    }

    function drawCoffeeSteam(sx, sy) {
      ctx.save();
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1;
      for (let i = 0; i < 3; i++) {
        const ox = Math.sin(animTimer * 2 + i * 1.3) * 3;
        ctx.beginPath();
        ctx.moveTo(sx + i * 3, sy);
        ctx.quadraticCurveTo(sx + i * 3 + ox, sy - 5, sx + i * 3 - ox * 0.5, sy - 10);
        ctx.stroke();
      }
      ctx.restore();
    }

    // ─── State ───
    let characters = [];
    let spawnedCharIds = {};
    let activeAgents = {};
    const canvas = document.getElementById('office-canvas');
    const ctx = canvas.getContext('2d');
    let lastTime = 0;
    let animTimer = 0;
    let hoveredEntity = null;

    // ─── Tic-Tac-Toe State ───
    let tttState = 'idle';       // 'idle' | 'choice' | 'playing' | 'result'
    let tttCharId = null;
    let tttCharData = null;
    let tttCharSlotIdx = -1;
    let tttBoard = [0,0,0,0,0,0,0,0,0]; // 0=empty, 1=player(X), 2=AI(O)
    let tttPlayerTurn = true;
    let tttWinner = 0;           // 0=none, 1=player, 2=AI, 3=draw
    let tttWinLine = null;       // [a,b,c] winning triple
    let tttAiThinking = false;
    let tttAnimProgress = 0;     // 0..1 enter/exit
    let tttAnimDir = 0;          // 1=appearing, -1=disappearing
    let tttBubbleText = '';
    let tttBubbleTimer = 0;
    let tttMoveCount = 0;
    let tttLastMove = -1;
    let choiceBtnWork = null;
    let choiceBtnGame = null;

    const TTT_COMMENTS = {
      gameStart: [
        "Oh, you want to play? Cute.",
        "Prepare to lose, human!",
        "I was trained on millions of games. Just saying.",
        "Let's go! I'll try not to embarrass you.",
        "A worthy challenger? We'll see about that.",
      ],
      aiThinking: [
        "Computing optimal strategy... jk",
        "Hmm, let me think...",
        "Processing... beep boop...",
        "Consulting my neural networks...",
        "One moment, genius at work.",
      ],
      aiGoodMove: [
        "That's what 100B parameters gets you.",
        "Pretty good, right?",
        "I'd say I'm sorry, but I'm not.",
        "Strategic brilliance, if I do say so myself.",
        "You didn't see that coming, did you?",
      ],
      aiBlocks: [
        "Nice try, but I saw that coming!",
        "Blocked! Did you think I'd miss that?",
        "Nope! Not on my watch.",
        "I read your mind. Well, your board.",
        "Ha! Denied!",
      ],
      playerGoodMove: [
        "OK, I'm slightly impressed.",
        "Not bad for a human.",
        "Lucky move... right?",
        "Hmm, you might actually be good at this.",
        "Alright, I see you!",
      ],
      playerBlocks: [
        "Hey! That was my winning move!",
        "Rude! I was going to win there!",
        "OK fine, you blocked me. This time.",
        "How dare you!",
        "Well played... I guess.",
      ],
      aiWins: [
        "GG! Better luck next compile!",
        "I win! Surprised? I'm not.",
        "All according to plan.",
        "Maybe try checkers instead?",
        "Victory is mine! *robot dance*",
      ],
      playerWins: [
        "I blame my training data.",
        "Wait, that's illegal... oh wait, it's not.",
        "You got lucky! Best of 3?",
        "My GPU must be overheating.",
        "OK you win. Don't tell anyone.",
      ],
      draw: [
        "Neither wins. The universe is in harmony.",
        "A tie! How perfectly balanced.",
        "Stalemate. We're equally matched... I guess.",
        "Nobody wins, nobody loses. How zen.",
        "Draw! At least I didn't lose.",
      ],
    };

    function getTTTComment(moment) {
      const arr = TTT_COMMENTS[moment];
      if (!arr || arr.length === 0) return '';
      return arr[Math.floor(Math.random() * arr.length)];
    }

    // ─── MetroCity layered sprite loading ───
    let mcReady = false;
    let mcBodyImg = null;
    let mcHairsImg = null;
    let mcShadowImg = null;
    const mcOutfitImgs = [];
    // Composited character canvases: charSheets[i] = full spritesheet for character i
    const charSheets = [];

    function loadImg(src) {
      return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = src;
      });
    }

    async function loadMetroCitySprites() {
      const [body, hairs, shadow, ...outfits] = await Promise.all([
        loadImg(MC_BODY_URL),
        loadImg(MC_HAIRS_URL),
        loadImg(MC_SHADOW_URL),
        ...MC_OUTFIT_URLS.map(u => loadImg(u)),
      ]);
      mcBodyImg = body;
      mcHairsImg = hairs;
      mcShadowImg = shadow;
      outfits.forEach(o => mcOutfitImgs.push(o));

      if (!body) return;

      // Composite each character combo into a full spritesheet canvas
      for (const combo of CHAR_COMBOS) {
        const sw = MC_COLS * MC_FRAME; // 768
        const sh = MC_FRAME;           // 32 (single row of animation)
        const c = document.createElement('canvas');
        c.width = sw;
        c.height = sh;
        const cx = c.getContext('2d');
        cx.imageSmoothingEnabled = false;

        // Draw body (one row = one skin tone)
        cx.drawImage(body, 0, combo.bodyRow * MC_FRAME, sw, MC_FRAME, 0, 0, sw, sh);

        // Overlay outfit
        const outfitImg = mcOutfitImgs[combo.outfit];
        if (outfitImg) {
          cx.drawImage(outfitImg, 0, 0, sw, MC_FRAME, 0, 0, sw, sh);
        }

        // Overlay hair (one row = one hair style/color)
        if (hairs) {
          cx.drawImage(hairs, 0, combo.hairRow * MC_FRAME, sw, MC_FRAME, 0, 0, sw, sh);
        }

        charSheets.push(c);
      }

      mcReady = true;
    }

    loadMetroCitySprites();

    // SVG image cache (fallback)
    const imageCache = {};
    function getCharImage(charData) {
      if (imageCache[charData.id]) return imageCache[charData.id];
      const img = new Image();
      img.src = 'data:' + (charData.mimeType || 'image/png') + ';base64,' + charData.imageData;
      img.onload = () => { imageCache[charData.id] = img; };
      return null;
    }

    // ─── Canvas resize (DPR-aware like pixel-agents) ───
    let dpr = window.devicePixelRatio || 1;
    function resize() {
      dpr = window.devicePixelRatio || 1;
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;
    }
    window.addEventListener('resize', resize);
    resize();

    // ─── Room layout (responsive) ───
    function getRoomLayout() {
      const cw = window.innerWidth;
      const ch = window.innerHeight;
      const pad = 12;
      const gap = ROOM_GAP;
      const pillSpace = 36; // space for label pill below room

      // Decide layout mode: horizontal if wide enough, else vertical
      const horizontal = cw > ch * 1.2 && cw >= 500;

      let rw, rh, ox, oy;
      const rooms = [];

      if (horizontal) {
        // 3 rooms side by side — fill available width and height
        rw = Math.floor((cw - pad * 2 - gap * 2) / 3);
        rh = Math.floor(ch - pad * 2 - pillSpace);
        rw = Math.max(rw, 160);
        rh = Math.max(rh, 140);
        ox = Math.floor((cw - (rw * 3 + gap * 2)) / 2);
        oy = Math.floor((ch - rh - pillSpace) / 2);
        rooms.push({ x: ox, y: oy, label: 'BREAK ROOM', style: 'break' });
        rooms.push({ x: ox + rw + gap, y: oy, label: 'OFFICE', style: 'office' });
        rooms.push({ x: ox + (rw + gap) * 2, y: oy, label: 'LIBRARY', style: 'library' });
      } else {
        // Vertical stack — each room fills width, share height
        rw = Math.floor(cw - pad * 2);
        rh = Math.floor((ch - pad * 2 - gap * 2 - pillSpace * 3) / 3);
        rw = Math.max(rw, 160);
        rh = Math.max(rh, 100);
        ox = Math.floor((cw - rw) / 2);
        oy = pad;
        for (let i = 0; i < 3; i++) {
          const labels = ['BREAK ROOM', 'OFFICE', 'LIBRARY'];
          const styles = ['break', 'office', 'library'];
          rooms.push({
            x: ox,
            y: oy + i * (rh + gap + pillSpace),
            label: labels[i],
            style: styles[i],
          });
        }
      }

      return { rw, rh, ox, oy, rooms };
    }

    // Slot positions per room type (relative to room top-left)
    function getRoomSlotsForType(rw, rh, style) {
      if (style === 'break') {
        return [
          { x: rw * 0.20, y: rh * 0.55 },
          { x: rw * 0.45, y: rh * 0.60 },
          { x: rw * 0.70, y: rh * 0.55 },
          { x: rw * 0.30, y: rh * 0.75 },
          { x: rw * 0.60, y: rh * 0.75 },
        ];
      }
      if (style === 'office') {
        return [
          { x: rw * 0.18, y: rh * 0.38 },
          { x: rw * 0.55, y: rh * 0.38 },
          { x: rw * 0.18, y: rh * 0.68 },
          { x: rw * 0.55, y: rh * 0.68 },
          { x: rw * 0.85, y: rh * 0.52 },
        ];
      }
      // library
      return [
        { x: rw * 0.25, y: rh * 0.58 },
        { x: rw * 0.50, y: rh * 0.58 },
        { x: rw * 0.75, y: rh * 0.55 },
        { x: rw * 0.35, y: rh * 0.75 },
        { x: rw * 0.65, y: rh * 0.75 },
      ];
    }

    // Backward-compatible wrapper
    function getRoomSlots(rw, rh) {
      return getRoomSlotsForType(rw, rh, 'office');
    }

    function getSlotInRoom(roomIdx, slotIdx, layout) {
      const room = layout.rooms[roomIdx];
      const slots = getRoomSlotsForType(layout.rw, layout.rh, room.style);
      const s = slots[slotIdx % slots.length];
      return { x: room.x + s.x - CHAR_SIZE / 2, y: room.y + s.y - CHAR_SIZE / 2 };
    }

    // ─── Draw procedural room ───
    const PALETTES = {
      'break':   { floor: '#4A3728', floorLine: 'rgba(255,200,120,0.08)', floorHi: 'rgba(255,200,120,0.04)', wall: '#6B5344', accent: '#D4A574' },
      'office':  { floor: '#2D2B50', floorLine: 'rgba(127,133,245,0.06)', floorHi: 'rgba(127,133,245,0.03)', wall: '#3F3D6B', accent: '#7F85F5' },
      'library': { floor: '#2A3A2E', floorLine: 'rgba(100,180,255,0.07)', floorHi: 'rgba(100,180,255,0.03)', wall: '#2E4A50', accent: '#64B5F6' },
    };

    function drawRoomBase(x, y, rw, rh, pal, style) {
      const wallH = Math.round(rh * 0.145); // ~32px at 220px height, scales proportionally

      // Drop shadow
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 20;
      ctx.shadowOffsetX = 4;
      ctx.shadowOffsetY = 4;
      ctx.fillStyle = pal.floor;
      ctx.beginPath();
      ctx.roundRect(x, y, rw, rh, 10);
      ctx.fill();
      ctx.restore();

      // Floor fill
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, y, rw, rh, 10);
      ctx.clip();

      if (style === 'break') {
        drawWoodPlanks(x, y + wallH, rw, rh - wallH, '#4A3728', 'rgba(0,0,0,0.12)', 'rgba(255,200,120,0.04)', 18);
      } else if (style === 'office') {
        drawCarpetPattern(x, y + wallH, rw, rh - wallH, '#2D2B50', 'rgba(127,133,245,0.08)', 'rgba(90,85,128,0.06)', 8);
      } else {
        drawWoodPlanks(x, y + wallH, rw, rh - wallH, '#2A3A2E', 'rgba(0,0,0,0.10)', 'rgba(100,180,255,0.03)', 14);
      }

      // Ambient overhead light
      const grad = ctx.createRadialGradient(x + rw / 2, y + 20, 10, x + rw / 2, y + rh / 2, rw * 0.6);
      grad.addColorStop(0, 'rgba(255,255,220,0.06)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, rw, rh);

      ctx.restore();

      // Wall strip
      ctx.fillStyle = pal.wall;
      ctx.beginPath();
      ctx.roundRect(x, y, rw, wallH, [10, 10, 0, 0]);
      ctx.fill();
      // Wall highlight
      ctx.fillStyle = 'rgba(255,255,255,0.10)';
      ctx.fillRect(x + 10, y + 2, rw - 20, 2);
      // Baseboard
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(x + 4, y + wallH - 2, rw - 8, 3);
    }

    function drawBreakRoomFurniture(x, y, rw, rh) {
      // ── Window on wall ──
      const wx = x + rw - 70, wy = y + 4;
      ctx.fillStyle = '#87CEEB';
      ctx.fillRect(wx, wy, 50, 24);
      ctx.strokeStyle = '#D4A574';
      ctx.lineWidth = 2;
      ctx.strokeRect(wx, wy, 50, 24);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(wx + 25, wy);
      ctx.lineTo(wx + 25, wy + 24);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(wx, wy + 12);
      ctx.lineTo(wx + 50, wy + 12);
      ctx.stroke();
      // Sky highlight
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(wx + 2, wy + 2, 10, 8);

      // ── Kitchen counter along back wall ──
      const kx = x + 12, ky = y + 33;
      ctx.fillStyle = '#5C3D2E';
      ctx.beginPath();
      ctx.roundRect(kx, ky, 120, 32, 2);
      ctx.fill();
      // Counter top
      ctx.fillStyle = '#8B7355';
      ctx.fillRect(kx, ky, 120, 5);
      // Cabinet doors
      for (let d = 0; d < 3; d++) {
        const dx = kx + 5 + d * 38;
        ctx.strokeStyle = 'rgba(0,0,0,0.2)';
        ctx.lineWidth = 1;
        ctx.strokeRect(dx, ky + 8, 32, 20);
        // Knob
        ctx.fillStyle = '#D4A574';
        ctx.beginPath();
        ctx.arc(dx + 16, ky + 18, 2, 0, Math.PI * 2);
        ctx.fill();
      }

      // ── Coffee machine on counter ──
      const cmx = kx + 90, cmy = ky - 16;
      ctx.fillStyle = '#333';
      ctx.beginPath();
      ctx.roundRect(cmx, cmy, 24, 16, 2);
      ctx.fill();
      // LED
      ctx.fillStyle = '#4CAF50';
      ctx.beginPath();
      ctx.arc(cmx + 20, cmy + 4, 2, 0, Math.PI * 2);
      ctx.fill();
      // Steam
      drawCoffeeSteam(cmx + 8, cmy - 2);

      // ── Plants ──
      drawPlant(x + 14, y + rh - 18, 1.3, '#8B4513', '#4CAF50');
      drawPlant(x + rw - 20, y + rh - 14, 0.9, '#A0522D', '#66BB6A');
    }

    function drawOfficeFurniture(x, y, rw, rh) {
      // ── Teams poster on wall ──
      const ppx = x + rw / 2 - 15, ppy = y + 4;
      ctx.fillStyle = '#6264A7';
      ctx.beginPath();
      ctx.roundRect(ppx, ppy, 30, 22, 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 1;
      ctx.strokeRect(ppx, ppy, 30, 22);
      // "T" icon
      ctx.fillStyle = '#FFF';
      ctx.font = 'bold 14px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('T', ppx + 15, ppy + 17);

      // Desk positions: 2 back row, 2 front row
      const deskCfg = [
        { dx: x + 10,  dy: y + 36, scr: '#3B82F6', phase: 0 },
        { dx: x + 145, dy: y + 36, scr: '#7F85F5', phase: 1.5 },
        { dx: x + 10,  dy: y + rh - 75, scr: '#22D3EE', phase: 3.0 },
        { dx: x + 145, dy: y + rh - 75, scr: '#A78BFA', phase: 4.5 },
      ];

      for (const d of deskCfg) {
        // Desk legs
        ctx.fillStyle = '#3A3560';
        ctx.fillRect(d.dx + 2, d.dy + 26, 3, 10);
        ctx.fillRect(d.dx + 105, d.dy + 26, 3, 10);
        // Desk surface
        ctx.fillStyle = '#4A4570';
        ctx.beginPath();
        ctx.roundRect(d.dx, d.dy, 110, 28, 2);
        ctx.fill();
        // Wood grain
        ctx.strokeStyle = 'rgba(255,255,255,0.04)';
        ctx.lineWidth = 1;
        for (let g = d.dx + 5; g < d.dx + 106; g += 12) {
          ctx.beginPath();
          ctx.moveTo(g, d.dy + 2);
          ctx.lineTo(g + 2, d.dy + 25);
          ctx.stroke();
        }
        // Monitor
        drawMonitor(d.dx + 40, d.dy - 16, 22, 16, d.scr, '#2A2550', d.phase);
        // Keyboard
        ctx.fillStyle = '#222';
        ctx.beginPath();
        ctx.roundRect(d.dx + 36, d.dy + 4, 30, 6, 1);
        ctx.fill();
        // Key dots
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        for (let k = 0; k < 8; k++) {
          ctx.fillRect(d.dx + 38 + k * 3.2, d.dy + 6, 2, 2);
        }
        // Mouse
        ctx.fillStyle = '#333';
        ctx.beginPath();
        ctx.roundRect(d.dx + 72, d.dy + 6, 5, 7, 2);
        ctx.fill();
      }

      // ── Chairs at each desk ──
      drawChair(x + 55, y + 66, '#5A5580');
      drawChair(x + 190, y + 66, '#5A5580');
      drawChair(x + 55, y + rh - 42, '#5A5580');
      drawChair(x + 190, y + rh - 42, '#5A5580');

      // ── Plant accent ──
      drawPlant(x + rw - 18, y + 42, 1.0, '#4A4570', '#66BB6A');
    }

    function drawLibraryFurniture(x, y, rw, rh) {
      // ── Large bookshelf on back wall ──
      const bx = x + 10, by = y + 33;
      ctx.fillStyle = '#5C3D2E';
      ctx.beginPath();
      ctx.roundRect(bx, by, 110, 34, 2);
      ctx.fill();
      // Shelves
      for (let s = 0; s < 3; s++) {
        const sy = by + 2 + s * 11;
        ctx.fillStyle = '#4A3220';
        ctx.fillRect(bx + 2, sy + 9, 106, 2);
        // Books
        let bxo = bx + 4;
        const bookColors = ['#E74856','#3B82F6','#FFB900','#4CAF50','#9C27B0','#FF6B35','#2196F3','#E91E63','#00BCD4','#8BC34A'];
        for (let b = 0; b < 8 + s; b++) {
          const bw = 3 + Math.floor(Math.random() * 0.1 + (b % 3));
          const bh = 6 + (b % 3);
          ctx.fillStyle = bookColors[(b + s * 3) % bookColors.length];
          ctx.fillRect(bxo, sy + 9 - bh, bw, bh);
          // Spine highlight
          ctx.fillStyle = 'rgba(255,255,255,0.15)';
          ctx.fillRect(bxo + 1, sy + 9 - bh + 1, 1, bh - 2);
          bxo += bw + 1;
          if (bxo > bx + 104) break;
        }
      }

      // ── Whiteboard on wall ──
      const wx = x + 135, wy = y + 4;
      ctx.fillStyle = '#C0C0C0';
      ctx.beginPath();
      ctx.roundRect(wx, wy, 70, 26, 2);
      ctx.fill();
      // White surface
      ctx.fillStyle = '#F5F5F5';
      ctx.fillRect(wx + 3, wy + 3, 64, 18);
      // Scribble lines
      ctx.strokeStyle = '#333';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(wx + 8, wy + 8);
      ctx.lineTo(wx + 35, wy + 8);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(wx + 8, wy + 12);
      ctx.lineTo(wx + 30, wy + 12);
      ctx.stroke();
      // Small diagram
      ctx.strokeStyle = '#3B82F6';
      ctx.beginPath();
      ctx.roundRect(wx + 42, wy + 6, 12, 8, 1);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(wx + 54, wy + 10);
      ctx.lineTo(wx + 60, wy + 10);
      ctx.stroke();
      // Marker tray
      ctx.fillStyle = '#999';
      ctx.fillRect(wx + 5, wy + 22, 40, 3);
      // Markers
      ctx.fillStyle = '#E74856';
      ctx.fillRect(wx + 8, wy + 21, 8, 2);
      ctx.fillStyle = '#3B82F6';
      ctx.fillRect(wx + 18, wy + 21, 8, 2);
      ctx.fillStyle = '#4CAF50';
      ctx.fillRect(wx + 28, wy + 21, 8, 2);
      // Red magnet
      ctx.fillStyle = '#E74856';
      ctx.beginPath();
      ctx.arc(wx + 60, wy + 6, 3, 0, Math.PI * 2);
      ctx.fill();

      // ── Small bookshelf (right side) ──
      const sbx = x + rw - 50, sby = y + 36;
      ctx.fillStyle = '#5C3D2E';
      ctx.beginPath();
      ctx.roundRect(sbx, sby, 38, 65, 2);
      ctx.fill();
      for (let s = 0; s < 4; s++) {
        const sy2 = sby + 2 + s * 15;
        ctx.fillStyle = '#4A3220';
        ctx.fillRect(sbx + 2, sy2 + 13, 34, 2);
        let bxo2 = sbx + 4;
        const bookColors2 = ['#FFB900','#9C27B0','#2196F3','#E91E63','#4CAF50','#FF6B35'];
        for (let b = 0; b < 5; b++) {
          const bw2 = 3 + (b % 2);
          const bh2 = 8 + (b % 3);
          ctx.fillStyle = bookColors2[(b + s * 2) % bookColors2.length];
          ctx.fillRect(bxo2, sy2 + 13 - bh2, bw2, bh2);
          bxo2 += bw2 + 1;
          if (bxo2 > sbx + 34) break;
        }
      }

      // ── Reading table ──
      const tx = x + 30, ty = y + rh * 0.50;
      // Legs
      ctx.fillStyle = '#3E2723';
      ctx.fillRect(tx + 4, ty + 22, 3, 12);
      ctx.fillRect(tx + 113, ty + 22, 3, 12);
      ctx.fillRect(tx + 4, ty + 40, 3, 12);
      ctx.fillRect(tx + 113, ty + 40, 3, 12);
      // Surface
      ctx.fillStyle = '#5C4033';
      ctx.beginPath();
      ctx.roundRect(tx, ty, 120, 50, 3);
      ctx.fill();
      // Wood grain
      ctx.strokeStyle = 'rgba(255,255,255,0.04)';
      ctx.lineWidth = 1;
      for (let g = tx + 6; g < tx + 115; g += 10) {
        ctx.beginPath();
        ctx.moveTo(g, ty + 2);
        ctx.lineTo(g + 2, ty + 47);
        ctx.stroke();
      }
      // Open book
      ctx.fillStyle = '#F5F0E0';
      ctx.fillRect(tx + 45, ty + 8, 30, 20);
      ctx.strokeStyle = '#999';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(tx + 60, ty + 8);
      ctx.lineTo(tx + 60, ty + 28);
      ctx.stroke();
      // Text lines
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      for (let tl = 0; tl < 5; tl++) {
        ctx.fillRect(tx + 48, ty + 11 + tl * 3, 10, 1);
        ctx.fillRect(tx + 63, ty + 11 + tl * 3, 10, 1);
      }

      // ── Desk lamp on table ──
      const lx = tx + 100, ly = ty + 2;
      // Base
      ctx.fillStyle = '#333';
      ctx.beginPath();
      ctx.ellipse(lx, ly + 6, 6, 3, 0, 0, Math.PI * 2);
      ctx.fill();
      // Arm
      ctx.strokeStyle = '#555';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(lx, ly + 4);
      ctx.lineTo(lx - 3, ly - 8);
      ctx.stroke();
      // Shade
      ctx.fillStyle = '#FFB900';
      ctx.beginPath();
      ctx.moveTo(lx - 8, ly - 8);
      ctx.lineTo(lx + 2, ly - 8);
      ctx.lineTo(lx, ly - 3);
      ctx.lineTo(lx - 6, ly - 3);
      ctx.closePath();
      ctx.fill();
      // Warm glow
      const glowAlpha = 0.15 + 0.05 * Math.sin(animTimer * 1.5);
      ctx.save();
      const lampGrad = ctx.createRadialGradient(lx - 3, ly - 4, 2, lx - 3, ly + 10, 30);
      lampGrad.addColorStop(0, 'rgba(255,200,80,' + glowAlpha + ')');
      lampGrad.addColorStop(1, 'rgba(255,200,80,0)');
      ctx.fillStyle = lampGrad;
      ctx.fillRect(lx - 35, ly - 15, 65, 50);
      ctx.restore();

      // ── Reading chairs ──
      // Left chair
      const lc = { x: tx - 10, y: ty + 12 };
      ctx.fillStyle = '#5C3D2E';
      ctx.fillRect(lc.x, lc.y, 14, 14);
      ctx.fillRect(lc.x + 1, lc.y - 10, 12, 12);
      // Slats
      ctx.strokeStyle = 'rgba(0,0,0,0.2)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(lc.x + 3, lc.y - 8);
      ctx.lineTo(lc.x + 3, lc.y + 1);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(lc.x + 7, lc.y - 8);
      ctx.lineTo(lc.x + 7, lc.y + 1);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(lc.x + 11, lc.y - 8);
      ctx.lineTo(lc.x + 11, lc.y + 1);
      ctx.stroke();

      // ── Potted plant ──
      drawPlant(x + 16, y + rh - 16, 1.1, '#5C3D2E', '#4CAF50');
    }

    // Design dimensions — furniture is authored for this size
    const DESIGN_RW = 280;
    const DESIGN_RH = 220;

    function drawRoom(room, rw, rh) {
      const { x, y, label, style } = room;
      const pal = PALETTES[style];

      drawRoomBase(x, y, rw, rh, pal, style);

      // Scale furniture to fit actual room size
      const sx = rw / DESIGN_RW;
      const sy = rh / DESIGN_RH;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(sx, sy);
      // Furniture functions receive (0,0) as room origin at design size
      if (style === 'break') drawBreakRoomFurniture(0, 0, DESIGN_RW, DESIGN_RH);
      else if (style === 'office') drawOfficeFurniture(0, 0, DESIGN_RW, DESIGN_RH);
      else drawLibraryFurniture(0, 0, DESIGN_RW, DESIGN_RH);
      ctx.restore();

      // Border
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(x, y, rw, rh, 10);
      ctx.stroke();

      // Label pill below room
      ctx.font = 'bold 11px "Segoe UI", sans-serif';
      const tw = ctx.measureText(label).width;
      const pillW = tw + 16;
      const pillX = x + (rw - pillW) / 2;
      const pillY = y + rh + 8;
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.roundRect(pillX, pillY, pillW, 20, 10);
      ctx.fill();
      ctx.fillStyle = pal.accent;
      ctx.textAlign = 'center';
      ctx.fillText(label, x + rw / 2, pillY + 14);
    }

    // ─── Draw nameplates in Office ───
    function drawNameplates(layout) {
      const officeRoom = layout.rooms[1];
      const slots = getRoomSlotsForType(layout.rw, layout.rh, 'office');
      const allChars = characters.slice(0, MAX_AGENTS);

      for (let i = 0; i < allChars.length; i++) {
        const s = slots[i % slots.length];
        const nx = officeRoom.x + s.x;
        const ny = officeRoom.y + s.y + CHAR_SIZE / 2 + 18;
        const name = allChars[i].name || 'Agent';

        ctx.font = '9px "Segoe UI", sans-serif';
        const tw = ctx.measureText(name).width;
        const pw = tw + 10;

        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.beginPath();
        ctx.roundRect(nx - pw / 2, ny, pw, 14, 4);
        ctx.fill();

        ctx.fillStyle = '#FFF';
        ctx.textAlign = 'center';
        ctx.fillText(name, nx, ny + 10);
      }
    }

    // ─── Draw character from sprite or SVG fallback ───
    // Get animation frame column for a character
    function getAnimFrame(isWalking, walkDirX, walkDirY) {
      if (!isWalking) return MC_IDLE_FRAME; // idle = down frame 0
      // Pick direction based on movement
      let anim = MC_ANIM.down;
      if (Math.abs(walkDirX) > Math.abs(walkDirY)) {
        anim = walkDirX < 0 ? MC_ANIM.left : MC_ANIM.right;
      } else {
        anim = walkDirY < 0 ? MC_ANIM.up : MC_ANIM.down;
      }
      const frameIdx = Math.floor(animTimer * 8) % anim.count;
      return anim.start + frameIdx;
    }

    function drawCharSprite(charData, px, py, size, bob, isWalking, walkDirX, walkDirY) {
      const si = charData.spriteIndex;
      if (si !== undefined && si !== null && si < charSheets.length && mcReady) {
        const sheet = charSheets[si];
        const frame = getAnimFrame(isWalking, walkDirX || 0, walkDirY || 0);
        const sx = frame * MC_FRAME;

        // Draw shadow
        if (mcShadowImg) {
          ctx.save();
          ctx.globalAlpha = 0.3;
          ctx.drawImage(mcShadowImg, 0, 0, 32, 32,
            px + size * 0.15, py + size - size * 0.15 + bob, size * 0.7, size * 0.25);
          ctx.restore();
        }

        // Draw character (crisp pixel art)
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(sheet, sx, 0, MC_FRAME, MC_FRAME, px, py + bob, size, size);
        return;
      }
      // Fallback: SVG image or placeholder
      const img = getCharImage(charData);
      if (img) {
        ctx.drawImage(img, px, py + bob, size, size);
      } else {
        ctx.fillStyle = '#6264A7';
        ctx.beginPath();
        ctx.roundRect(px + 4, py + 4 + bob, size - 8, size - 8, 8);
        ctx.fill();
        ctx.fillStyle = '#FFF';
        ctx.font = 'bold 18px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText((charData.name || 'A')[0], px + size / 2, py + size / 2 + 6 + bob);
      }
    }

    // ─── Tic-Tac-Toe Functions ───
    const TTT_WIN_LINES = [
      [0,1,2],[3,4,5],[6,7,8], // rows
      [0,3,6],[1,4,7],[2,5,8], // cols
      [0,4,8],[2,4,6],         // diags
    ];

    function hitTest(mx, my, rect) {
      return rect && mx >= rect.x && mx <= rect.x + rect.w && my >= rect.y && my <= rect.y + rect.h;
    }

    function getTTTBoardRect(layout) {
      const room = layout.rooms[0]; // Break Room
      const rw = layout.rw;
      const rh = layout.rh;
      const size = Math.min(rw * 0.45, rh * 0.40, 120);
      const bx = room.x + rw * 0.5 - size / 2;
      const by = room.y + rh * 0.48 - size / 2;
      return { x: bx, y: by, w: size, h: size };
    }

    function checkTTTWinner() {
      for (const line of TTT_WIN_LINES) {
        const [a, b, c] = line;
        if (tttBoard[a] && tttBoard[a] === tttBoard[b] && tttBoard[a] === tttBoard[c]) {
          tttWinLine = line;
          return tttBoard[a]; // 1=player, 2=AI
        }
      }
      if (tttBoard.every(v => v !== 0)) return 3; // draw
      return 0;
    }

    function findWinningMove(player) {
      for (let i = 0; i < 9; i++) {
        if (tttBoard[i] !== 0) continue;
        tttBoard[i] = player;
        const win = checkTTTWinner();
        tttBoard[i] = 0;
        if (win === player) return i;
      }
      return -1;
    }

    function tttAiMove() {
      // 1. Win if possible
      let move = findWinningMove(2);
      if (move !== -1) return move;
      // 2. Block player win
      move = findWinningMove(1);
      if (move !== -1) return move;
      // 3. 70% optimal, 30% random
      if (Math.random() < 0.7) {
        // Center
        if (tttBoard[4] === 0) return 4;
        // Corners
        const corners = [0, 2, 6, 8].filter(i => tttBoard[i] === 0);
        if (corners.length > 0) return corners[Math.floor(Math.random() * corners.length)];
        // Edges
        const edges = [1, 3, 5, 7].filter(i => tttBoard[i] === 0);
        if (edges.length > 0) return edges[Math.floor(Math.random() * edges.length)];
      }
      // Random empty cell
      const empty = tttBoard.map((v, i) => v === 0 ? i : -1).filter(i => i !== -1);
      return empty.length > 0 ? empty[Math.floor(Math.random() * empty.length)] : -1;
    }

    function showTTTChoice(charId) {
      const available = getAvailableChars();
      const idx = available.findIndex(c => c.id === charId);
      if (idx === -1) return;
      tttState = 'choice';
      tttCharId = charId;
      tttCharData = available[idx];
      tttCharSlotIdx = idx;
      tttAnimProgress = 0;
      tttAnimDir = 1;
    }

    function startTTTGame() {
      tttState = 'playing';
      tttBoard = [0,0,0,0,0,0,0,0,0];
      tttPlayerTurn = true;
      tttWinner = 0;
      tttWinLine = null;
      tttAiThinking = false;
      tttMoveCount = 0;
      tttLastMove = -1;
      tttAnimProgress = 0;
      tttAnimDir = 1;
      tttBubbleText = getTTTComment('gameStart');
      tttBubbleTimer = 2.5;
    }

    function makePlayerMove(idx) {
      if (tttBoard[idx] !== 0 || !tttPlayerTurn || tttAiThinking || tttWinner) return;
      // Check if player blocked AI
      const aiWouldWin = findWinningMove(2);
      tttBoard[idx] = 1;
      tttLastMove = idx;
      tttMoveCount++;
      tttPlayerTurn = false;
      const w = checkTTTWinner();
      if (w) {
        tttWinner = w;
        tttState = 'result';
        tttBubbleText = getTTTComment(w === 1 ? 'playerWins' : 'draw');
        tttBubbleTimer = 3;
        setTimeout(() => { if (tttState === 'result') resetTTT(); }, 3000);
        return;
      }
      if (aiWouldWin === idx) {
        tttBubbleText = getTTTComment('playerBlocks');
        tttBubbleTimer = 2;
      } else if (tttMoveCount >= 3) {
        tttBubbleText = getTTTComment('playerGoodMove');
        tttBubbleTimer = 2;
      }
      // AI moves after delay
      tttAiThinking = true;
      const delay = 600 + Math.random() * 600;
      setTimeout(() => makeAiMove(), delay);
    }

    function makeAiMove() {
      if (tttWinner || tttState !== 'playing') { tttAiThinking = false; return; }
      // Check if AI is blocking player
      const playerWouldWin = findWinningMove(1);
      const move = tttAiMove();
      if (move === -1) { tttAiThinking = false; return; }
      tttBoard[move] = 2;
      tttLastMove = move;
      tttMoveCount++;
      tttAiThinking = false;
      tttPlayerTurn = true;
      const w = checkTTTWinner();
      if (w) {
        tttWinner = w;
        tttState = 'result';
        tttBubbleText = getTTTComment(w === 2 ? 'aiWins' : w === 3 ? 'draw' : 'playerWins');
        tttBubbleTimer = 3;
        setTimeout(() => { if (tttState === 'result') resetTTT(); }, 3000);
        return;
      }
      if (playerWouldWin === move) {
        tttBubbleText = getTTTComment('aiBlocks');
        tttBubbleTimer = 2;
      } else {
        tttBubbleText = getTTTComment('aiGoodMove');
        tttBubbleTimer = 2;
      }
    }

    function resetTTT() {
      tttAnimDir = -1;
      setTimeout(() => completeTTTReset(), 300);
    }

    function completeTTTReset() {
      tttState = 'idle';
      tttCharId = null;
      tttCharData = null;
      tttCharSlotIdx = -1;
      tttBoard = [0,0,0,0,0,0,0,0,0];
      tttPlayerTurn = true;
      tttWinner = 0;
      tttWinLine = null;
      tttAiThinking = false;
      tttAnimProgress = 0;
      tttAnimDir = 0;
      tttBubbleText = '';
      tttBubbleTimer = 0;
      tttMoveCount = 0;
      tttLastMove = -1;
      choiceBtnWork = null;
      choiceBtnGame = null;
    }

    function drawTTTChoiceMenu(layout) {
      if (!tttCharData) return;
      const pos = getSlotInRoom(0, tttCharSlotIdx, layout);
      const cx = pos.x + CHAR_SIZE / 2;
      const cy = pos.y - 10;
      const scale = 0.7 + 0.3 * tttAnimProgress;
      const alpha = tttAnimProgress;
      const btnW = 130, btnH = 28, gap = 6;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(cx, cy);
      ctx.scale(scale, scale);

      // "Start Working" button
      const workY = -btnH - gap / 2;
      ctx.fillStyle = '#6264A7';
      ctx.beginPath();
      ctx.roundRect(-btnW / 2, workY, btnW, btnH, 6);
      ctx.fill();
      // Monitor icon
      ctx.fillStyle = '#FFF';
      ctx.fillRect(-btnW / 2 + 10, workY + 8, 12, 9);
      ctx.fillRect(-btnW / 2 + 14, workY + 17, 4, 3);
      ctx.fillRect(-btnW / 2 + 11, workY + 20, 10, 1);
      // Text
      ctx.fillStyle = '#FFF';
      ctx.font = 'bold 11px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Start Working', 8, workY + 18);

      // "Play Tic-Tac-Toe" button
      const gameY = gap / 2;
      ctx.fillStyle = '#FFB900';
      ctx.beginPath();
      ctx.roundRect(-btnW / 2, gameY, btnW, btnH, 6);
      ctx.fill();
      // Grid icon
      ctx.strokeStyle = '#1E1E2E';
      ctx.lineWidth = 1.5;
      const gx = -btnW / 2 + 12, gy = gameY + 7;
      ctx.beginPath();
      ctx.moveTo(gx + 5, gy); ctx.lineTo(gx + 5, gy + 14);
      ctx.moveTo(gx + 10, gy); ctx.lineTo(gx + 10, gy + 14);
      ctx.moveTo(gx, gy + 5); ctx.lineTo(gx + 15, gy + 5);
      ctx.moveTo(gx, gy + 10); ctx.lineTo(gx + 15, gy + 10);
      ctx.stroke();
      // Text
      ctx.fillStyle = '#1E1E2E';
      ctx.font = 'bold 11px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Play Tic-Tac-Toe', 8, gameY + 18);

      ctx.restore();

      // Store hit rects (untransformed coordinates)
      const invScale = 1 / scale;
      choiceBtnWork = {
        x: cx - (btnW / 2) * scale,
        y: cy + workY * scale,
        w: btnW * scale,
        h: btnH * scale,
      };
      choiceBtnGame = {
        x: cx - (btnW / 2) * scale,
        y: cy + (gap / 2) * scale,
        w: btnW * scale,
        h: btnH * scale,
      };
    }

    function drawTTTBoard(layout) {
      const br = getTTTBoardRect(layout);
      const scale = 0.7 + 0.3 * tttAnimProgress;
      const alpha = tttAnimProgress;
      const cx = br.x + br.w / 2;
      const cy = br.y + br.h / 2;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(cx, cy);
      ctx.scale(scale, scale);
      ctx.translate(-br.w / 2, -br.h / 2);

      // Background panel
      const pad = 14;
      ctx.fillStyle = 'rgba(30,30,46,0.88)';
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 16;
      ctx.beginPath();
      ctx.roundRect(-pad, -pad, br.w + pad * 2, br.h + pad * 2, 10);
      ctx.fill();
      ctx.shadowBlur = 0;

      const cellW = br.w / 3;
      const cellH = br.h / 3;

      // Grid lines
      ctx.strokeStyle = '#D4A574';
      ctx.lineWidth = 2;
      for (let i = 1; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(i * cellW, 0);
        ctx.lineTo(i * cellW, br.h);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, i * cellH);
        ctx.lineTo(br.w, i * cellH);
        ctx.stroke();
      }

      // Cells
      for (let i = 0; i < 9; i++) {
        const col = i % 3;
        const row = Math.floor(i / 3);
        const x = col * cellW;
        const y = row * cellH;

        // Last move highlight
        if (i === tttLastMove) {
          ctx.fillStyle = 'rgba(255,185,0,0.12)';
          ctx.fillRect(x + 1, y + 1, cellW - 2, cellH - 2);
        }

        const margin = cellW * 0.2;
        if (tttBoard[i] === 1) {
          // X (player) - gold
          ctx.strokeStyle = '#FFB900';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(x + margin, y + margin);
          ctx.lineTo(x + cellW - margin, y + cellH - margin);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x + cellW - margin, y + margin);
          ctx.lineTo(x + margin, y + cellH - margin);
          ctx.stroke();
        } else if (tttBoard[i] === 2) {
          // O (AI) - purple
          ctx.strokeStyle = '#7F85F5';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(x + cellW / 2, y + cellH / 2, cellW / 2 - margin, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // Winning line
      if (tttWinLine) {
        const [a, , c] = tttWinLine;
        const ax = (a % 3) * cellW + cellW / 2;
        const ay = Math.floor(a / 3) * cellH + cellH / 2;
        const cx2 = (c % 3) * cellW + cellW / 2;
        const cy2 = Math.floor(c / 3) * cellH + cellH / 2;
        ctx.strokeStyle = tttWinner === 1 ? '#FFB900' : '#7F85F5';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(cx2, cy2);
        ctx.stroke();
      }

      // Turn / result indicator
      ctx.fillStyle = '#FFF';
      ctx.font = 'bold 10px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      let statusText = '';
      if (tttWinner === 1) statusText = 'You win!';
      else if (tttWinner === 2) statusText = 'AI wins!';
      else if (tttWinner === 3) statusText = "It's a draw!";
      else if (tttAiThinking) statusText = 'AI thinking...';
      else statusText = 'Your turn (X)';
      ctx.fillText(statusText, br.w / 2, br.h + pad + 2);

      ctx.restore();
    }

    function drawTTTBubble(layout) {
      if (!tttBubbleText || !tttCharData) return;
      const pos = getSlotInRoom(0, tttCharSlotIdx, layout);
      const bx = pos.x + CHAR_SIZE / 2;
      const by = pos.y - 20;

      ctx.font = '10px "Segoe UI", sans-serif';
      const text = tttBubbleText.length > 45 ? tttBubbleText.slice(0, 45) + '...' : tttBubbleText;
      const tw = ctx.measureText(text).width;
      const pad = 8;

      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.shadowColor = 'rgba(0,0,0,0.3)';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.roundRect(bx - tw / 2 - pad, by - 14, tw + pad * 2, 20, 6);
      ctx.fill();
      ctx.shadowBlur = 0;
      // Tail
      ctx.beginPath();
      ctx.moveTo(bx - 5, by + 6);
      ctx.lineTo(bx, by + 13);
      ctx.lineTo(bx + 5, by + 6);
      ctx.fill();
      ctx.restore();

      ctx.fillStyle = '#1E1E2E';
      ctx.textAlign = 'center';
      ctx.font = '10px "Segoe UI", sans-serif';
      ctx.fillText(text, bx, by);
    }

    // ─── Draw unspawned character in Break Room ───
    function drawBreakCharacter(charData, slotIdx, layout) {
      const pos = getSlotInRoom(0, slotIdx, layout);
      const S = CHAR_SIZE;
      const px = pos.x;
      const py = pos.y;
      const isHovered = hoveredEntity && hoveredEntity.type === 'char' && hoveredEntity.id === charData.id;
      const isPlaying = tttState !== 'idle' && tttCharId === charData.id;
      const isDimmed = tttState !== 'idle' && !isPlaying;

      charData._px = px; charData._py = py; charData._size = S;

      ctx.save();
      if (isDimmed) ctx.globalAlpha = 0.3;

      // Shadow
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.ellipse(px + S / 2, py + S - 2, S / 2 - 4, 5, 0, 0, Math.PI * 2);
      ctx.fill();

      if (isPlaying) {
        // Selection glow for playing character
        ctx.save();
        ctx.shadowColor = '#7F85F5';
        ctx.shadowBlur = 14;
        ctx.strokeStyle = 'rgba(127,133,245,0.7)';
        ctx.lineWidth = 2;
        ctx.strokeRect(px - 3, py - 3, S + 6, S + 6);
        ctx.restore();
      } else if (isHovered && tttState === 'idle') {
        ctx.save();
        ctx.shadowColor = '#FFB900';
        ctx.shadowBlur = 12;
        ctx.strokeStyle = 'rgba(255,185,0,0.6)';
        ctx.lineWidth = 2;
        ctx.strokeRect(px - 3, py - 3, S + 6, S + 6);
        ctx.restore();
      }

      const bob = Math.sin(animTimer * 1.5 + slotIdx * 1.2) * 1.5;
      drawCharSprite(charData, px, py, S, bob, false, 0, 0);

      ctx.fillStyle = (isHovered && tttState === 'idle') ? '#FFF' : '#C8C6C4';
      ctx.font = '11px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(charData.name || 'Agent', px + S / 2, py + S + 14);

      if (isHovered && tttState === 'idle') {
        ctx.fillStyle = '#FFB900';
        ctx.font = '10px "Segoe UI", sans-serif';
        ctx.fillText('Click to start', px + S / 2, py + S + 26);
      }

      ctx.restore();
    }

    // ─── Draw spawned agent ───
    function drawAgent(agentId, agent) {
      const S = CHAR_SIZE;
      const px = agent.currentX;
      const py = agent.currentY;
      const actColor = ACT_COLORS[agent.activity] || '#888';
      const isHovered = hoveredEntity && hoveredEntity.type === 'agent' && hoveredEntity.id === agentId;
      const isWalking = Math.abs(agent.currentX - agent.targetX) > 2 ||
                        Math.abs(agent.currentY - agent.targetY) > 2;

      agent._px = px; agent._py = py; agent._size = S;

      // Shadow
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.ellipse(px + S / 2, py + S - 2, S / 2 - 4, 5, 0, 0, Math.PI * 2);
      ctx.fill();

      // Activity glow
      if (agent.activity !== 'idle' && !isWalking) {
        ctx.save();
        ctx.globalAlpha = 0.4 + Math.sin(animTimer * 3) * 0.2;
        ctx.strokeStyle = actColor;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(px + S / 2, py + S / 2, S / 2 + 6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      if (isHovered) {
        ctx.save();
        ctx.shadowColor = '#FFF';
        ctx.shadowBlur = 10;
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 2;
        ctx.strokeRect(px - 3, py - 3, S + 6, S + 6);
        ctx.restore();
      }

      const bob = isWalking
        ? Math.sin(animTimer * 10) * 3
        : (agent.activity !== 'idle' ? Math.sin(animTimer * 5) * 2 : 0);

      const walkDirX = agent.targetX - agent.currentX;
      const walkDirY = agent.targetY - agent.currentY;
      drawCharSprite(agent.charData || {}, px, py, S, bob, isWalking, walkDirX, walkDirY);

      // Status dot
      ctx.fillStyle = actColor;
      ctx.beginPath();
      ctx.arc(px + S - 4, py + 6, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#1E1E2E';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Name
      ctx.fillStyle = isHovered ? '#FFF' : '#C8C6C4';
      ctx.font = '11px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(agent.charData?.name || 'Agent', px + S / 2, py + S + 14);

      // Activity label
      const actLabel = ACT_LABELS[agent.activity] || '';
      if (actLabel && !isWalking) {
        ctx.fillStyle = actColor;
        ctx.font = '10px "Segoe UI", sans-serif';
        ctx.fillText(actLabel, px + S / 2, py + S + 26);
      }

      // Speech bubble
      if (!isWalking) {
        let bubbleText = '';
        if (agent.activity === 'waiting') {
          bubbleText = 'Waiting for input...';
        } else if (agent.activity === 'thinking' && (agent.thought || agent.detail)) {
          bubbleText = agent.thought || agent.detail;
        } else if (agent.activity !== 'idle' && agent.activity !== 'thinking' && (agent.detail || agent.toolName)) {
          bubbleText = agent.detail
            ? (agent.toolName || '') + ': ' + agent.detail
            : agent.toolName || '';
        }
        if (bubbleText) {
          const maxLen = agent.activity === 'thinking' ? 50 : 35;
          const text = bubbleText.length > maxLen ? bubbleText.slice(0, maxLen) + '...' : bubbleText;
          ctx.font = '10px "Segoe UI", sans-serif';
          const tw = ctx.measureText(text).width;
          const bx = px + S / 2;
          const by = py - 16;
          const pad = 8;
          ctx.fillStyle = 'rgba(255,255,255,0.95)';
          ctx.beginPath();
          ctx.roundRect(bx - tw / 2 - pad, by - 14, tw + pad * 2, 20, 6);
          ctx.fill();
          ctx.save();
          ctx.shadowColor = 'rgba(0,0,0,0.2)';
          ctx.shadowBlur = 4;
          ctx.fill();
          ctx.restore();
          // Tail
          ctx.fillStyle = 'rgba(255,255,255,0.95)';
          ctx.beginPath();
          ctx.moveTo(bx - 5, by + 6);
          ctx.lineTo(bx, by + 13);
          ctx.lineTo(bx + 5, by + 6);
          ctx.fill();
          ctx.fillStyle = '#1E1E2E';
          ctx.textAlign = 'center';
          ctx.fillText(text, bx, by);
        }
      }

      // Activity animations
      if (!isWalking) {
        if (agent.activity === 'writing' || agent.activity === 'running-command') {
          for (let i = 0; i < 4; i++) {
            const ppx = px + S / 2 + Math.sin(animTimer * 6 + i * 1.5) * 12;
            const ppy = py - 22 - i * 5 - Math.abs(Math.sin(animTimer * 4 + i)) * 3;
            ctx.fillStyle = actColor;
            ctx.globalAlpha = 0.7 - i * 0.15;
            ctx.fillRect(ppx, ppy, 3, 3);
          }
          ctx.globalAlpha = 1;
        }
        if (agent.activity === 'searching') {
          for (let i = 0; i < 3; i++) {
            const angle = animTimer * 3 + i * (Math.PI * 2 / 3);
            ctx.fillStyle = actColor;
            ctx.globalAlpha = 0.7;
            ctx.beginPath();
            ctx.arc(px + S / 2 + Math.cos(angle) * (S / 2 + 10),
                    py + S / 2 + Math.sin(angle) * (S / 2 + 10), 3, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }
        if (agent.activity === 'thinking') {
          for (let i = 0; i < 3; i++) {
            ctx.fillStyle = actColor;
            ctx.globalAlpha = 0.3 + 0.5 * Math.abs(Math.sin(animTimer * 2 + i * 0.8));
            ctx.beginPath();
            ctx.arc(px + S / 2 - 10 + i * 10, py - 20, 3, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }
        if (agent.activity === 'waiting') {
          for (let i = 0; i < 3; i++) {
            ctx.fillStyle = actColor;
            ctx.globalAlpha = 0.3 + 0.5 * Math.abs(Math.sin(animTimer * 1.2 + i * 1.0));
            ctx.beginPath();
            ctx.arc(px + S / 2 - 10 + i * 10, py - 20, 3, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }
      }
    }

    // ─── Smooth movement ───
    function updateAgentPositions(dt) {
      for (const agent of Object.values(activeAgents)) {
        const dx = agent.targetX - agent.currentX;
        const dy = agent.targetY - agent.currentY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 2) {
          agent.currentX = agent.targetX;
          agent.currentY = agent.targetY;
        } else {
          const step = Math.min(MOVE_SPEED * dt, dist);
          agent.currentX += (dx / dist) * step;
          agent.currentY += (dy / dist) * step;
        }
      }
    }

    function getAvailableChars() {
      return characters.filter(c => !spawnedCharIds[c.id]).slice(0, MAX_AGENTS);
    }

    // ─── Main render ───
    function render(timestamp) {
      const dt = Math.min((timestamp - lastTime) / 1000, 0.1);
      lastTime = timestamp;
      animTimer += dt;

      resize();
      updateAgentPositions(dt);

      const layout = getRoomLayout();

      ctx.fillStyle = '#1E1E2E';
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

      // Draw rooms
      for (const room of layout.rooms) {
        drawRoom(room, layout.rw, layout.rh);
      }

      // Unspawned characters in Break Room
      const available = getAvailableChars();
      for (let i = 0; i < available.length; i++) {
        drawBreakCharacter(available[i], i, layout);
      }

      // Spawned agents
      for (const [id, agent] of Object.entries(activeAgents)) {
        drawAgent(id, agent);
      }

      // TTT overlays
      if (tttState === 'choice') drawTTTChoiceMenu(layout);
      if (tttState === 'playing' || tttState === 'result') drawTTTBoard(layout);
      if (tttBubbleText && tttState !== 'idle') drawTTTBubble(layout);

      // TTT animation updates
      if (tttAnimDir !== 0) {
        tttAnimProgress += tttAnimDir * dt * 4; // ~0.25s transition
        tttAnimProgress = Math.max(0, Math.min(1, tttAnimProgress));
      }
      if (tttBubbleTimer > 0) {
        tttBubbleTimer -= dt;
        if (tttBubbleTimer <= 0) { tttBubbleText = ''; tttBubbleTimer = 0; }
      }

      // Empty state
      if (characters.length === 0 && Object.keys(activeAgents).length === 0) {
        ctx.fillStyle = '#555';
        ctx.font = '14px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Use "Add Custom Character" command to add characters',
          window.innerWidth / 2, window.innerHeight / 2);
      }

      requestAnimationFrame(render);
    }

    // ─── Mouse interaction ───
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      hoveredEntity = null;

      // TTT choice buttons hover
      if (tttState === 'choice') {
        if ((choiceBtnWork && hitTest(mx, my, choiceBtnWork)) ||
            (choiceBtnGame && hitTest(mx, my, choiceBtnGame))) {
          canvas.style.cursor = 'pointer';
          return;
        }
      }

      // TTT board cell hover
      if (tttState === 'playing' && tttPlayerTurn && !tttAiThinking && !tttWinner) {
        const layout = getRoomLayout();
        const br = getTTTBoardRect(layout);
        const scale = 0.7 + 0.3 * tttAnimProgress;
        const cx = br.x + br.w / 2;
        const cy = br.y + br.h / 2;
        const lx = (mx - cx) / scale + br.w / 2;
        const ly = (my - cy) / scale + br.h / 2;
        if (lx >= 0 && lx <= br.w && ly >= 0 && ly <= br.h) {
          const col = Math.floor(lx / (br.w / 3));
          const row = Math.floor(ly / (br.h / 3));
          const idx = row * 3 + col;
          if (idx >= 0 && idx < 9 && tttBoard[idx] === 0) {
            canvas.style.cursor = 'pointer';
            return;
          }
        }
      }

      // Normal character hover (only in idle state)
      const available = getAvailableChars();
      for (const c of available) {
        const s = c._size || CHAR_SIZE;
        if (c._px !== undefined &&
            mx >= c._px && mx <= c._px + s &&
            my >= c._py && my <= c._py + s) {
          hoveredEntity = { type: 'char', id: c.id };
          if (tttState === 'idle') {
            canvas.style.cursor = 'pointer';
          }
          return;
        }
      }

      for (const [id, agent] of Object.entries(activeAgents)) {
        const s = agent._size || CHAR_SIZE;
        if (agent._px !== undefined &&
            mx >= agent._px && mx <= agent._px + s &&
            my >= agent._py && my <= agent._py + s) {
          hoveredEntity = { type: 'agent', id };
          canvas.style.cursor = 'pointer';
          return;
        }
      }

      canvas.style.cursor = 'default';
    });

    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      // Agent clicks always pass through
      if (hoveredEntity && hoveredEntity.type === 'agent') {
        vscode.postMessage({ type: 'click-agent', agentId: hoveredEntity.id });
        return;
      }

      if (tttState === 'idle') {
        if (hoveredEntity && hoveredEntity.type === 'char') {
          showTTTChoice(hoveredEntity.id);
        }
      } else if (tttState === 'choice') {
        if (choiceBtnWork && hitTest(mx, my, choiceBtnWork)) {
          vscode.postMessage({ type: 'spawn-agent', characterId: tttCharId });
          completeTTTReset();
        } else if (choiceBtnGame && hitTest(mx, my, choiceBtnGame)) {
          startTTTGame();
        } else {
          completeTTTReset();
        }
      } else if (tttState === 'playing') {
        const layout = getRoomLayout();
        const br = getTTTBoardRect(layout);
        const scale = 0.7 + 0.3 * tttAnimProgress;
        const cx = br.x + br.w / 2;
        const cy = br.y + br.h / 2;
        // Transform mouse into board-local coords
        const lx = (mx - cx) / scale + br.w / 2;
        const ly = (my - cy) / scale + br.h / 2;
        if (lx >= 0 && lx <= br.w && ly >= 0 && ly <= br.h) {
          const col = Math.floor(lx / (br.w / 3));
          const row = Math.floor(ly / (br.h / 3));
          const idx = row * 3 + col;
          if (idx >= 0 && idx < 9) {
            makePlayerMove(idx);
          }
        } else {
          resetTTT();
        }
      } else if (tttState === 'result') {
        resetTTT();
      }
    });

    function updateAgentTarget(agent) {
      const roomIdx = activityToRoom(agent.activity);
      agent.roomIdx = roomIdx;
      const layout = getRoomLayout();
      const pos = getSlotInRoom(roomIdx, agent.slotIdx, layout);
      agent.targetX = pos.x;
      agent.targetY = pos.y;
    }

    // ─── Message handling ───
    window.addEventListener('message', (e) => {
      const msg = e.data;
      switch (msg.type) {
        case 'characters-updated':
          characters = msg.characters || [];
          characters.forEach(c => getCharImage(c));
          break;

        case 'agent-spawned': {
          const charData = msg.charData || characters.find(c => c.id === msg.characterId);
          if (charData) getCharImage(charData);

          spawnedCharIds[msg.characterId] = msg.agentId;

          const charIdx = characters.findIndex(c => c.id === msg.characterId);
          const slotIdx = Math.max(0, charIdx);

          const layout = getRoomLayout();
          const breakPos = getSlotInRoom(0, slotIdx, layout);
          const officePos = getSlotInRoom(1, slotIdx, layout);

          activeAgents[msg.agentId] = {
            characterId: msg.characterId,
            charData: charData || null,
            activity: 'idle',
            toolName: '',
            detail: '',
            thought: '',
            slotIdx: slotIdx,
            roomIdx: 1,
            currentX: breakPos.x,
            currentY: breakPos.y,
            targetX: officePos.x,
            targetY: officePos.y,
          };
          break;
        }

        case 'agent-activity': {
          const agent = activeAgents[msg.agentId];

          if (msg.returned && msg.characterId) {
            if (agent) delete activeAgents[msg.agentId];
            delete spawnedCharIds[msg.characterId];
            break;
          }

          if (agent) {
            agent.activity = msg.activity;
            agent.toolName = msg.toolName || '';
            agent.detail = msg.detail || '';
            if (msg.thought !== undefined) agent.thought = msg.thought;
            if (msg.activity === 'idle') agent.thought = '';
            updateAgentTarget(agent);
          }
          break;
        }
      }
    });

    // ─── Init ───
    requestAnimationFrame(render);
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
