import * as vscode from "vscode";
import { CharacterManager } from "./characterManager";
import { ClaudeWatcher } from "./claudeWatcher";

export class OfficePanel {
  private panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private _onDidDispose = new vscode.EventEmitter<void>();
  public readonly onDidDispose = this._onDidDispose.event;

  constructor(
    private context: vscode.ExtensionContext,
    private characterManager: CharacterManager,
    private claudeWatcher: ClaudeWatcher
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "teamsPixelAgents.office",
      "Teams Pixel Office",
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this.disposables
    );

    this.panel.webview.html = this.getHtml(this.panel.webview);
  }

  reveal() {
    this.panel.reveal();
  }

  postMessage(msg: Record<string, unknown>) {
    this.panel.webview.postMessage(msg);
  }

  refreshCharacters() {
    this.panel.webview.postMessage({
      type: "characters-updated",
      characters: this.characterManager.getAllCharacters(),
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

      case "spawn-agent": {
        const characterId = msg.characterId as string;
        const agentId = this.claudeWatcher.launchAgent(characterId);
        const allChars = this.characterManager.getAllCharacters();
        const charData = allChars.find((c) => c.id === characterId);
        this.panel.webview.postMessage({
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
      cursor: default;
    }
  </style>
</head>
<body>
  <canvas id="office-canvas"></canvas>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // ─── Constants ───
    const TILE = 32;
    const OW = 30, OH = 14;
    const CHAR_SIZE = 48;
    const MOVE_SPEED = 80; // pixels per second
    const MAX_AGENTS = 5;

    const ACT_COLORS = {
      idle: '#888', thinking: '#FFB900', writing: '#4CAF50',
      reading: '#2196F3', 'running-command': '#FF6B35', searching: '#9C27B0',
      waiting: '#00BCD4',
    };
    const ACT_LABELS = {
      idle: 'At desk', thinking: 'Thinking...', writing: 'Writing code',
      reading: 'Reading file', 'running-command': 'Running cmd', searching: 'Searching',
      waiting: 'Waiting for input',
    };

    // Room color palettes
    const ROOM_COLORS = {
      coffee: {
        floor: '#3A2E24', floorGrid: 'rgba(255,200,120,0.04)',
        wall: '#5C4033', wallHighlight: 'rgba(255,180,80,0.3)',
        label: '#D4A574',
      },
      office: {
        floor: '#252440', floorGrid: 'rgba(255,255,255,0.03)',
        wall: '#3B3966', wallHighlight: 'rgba(98,100,167,0.3)',
        label: '#7F85F5',
      },
      meeting: {
        floor: '#1E2A3A', floorGrid: 'rgba(100,180,255,0.04)',
        wall: '#2A4060', wallHighlight: 'rgba(80,150,220,0.3)',
        label: '#64B5F6',
      },
    };

    // ─── Activity → room mapping ───
    // Coffee Room = unspawned characters hanging out
    // Office = spawned agents (idle at desk + all work activities)
    // Meeting Room = waiting for user input
    function activityToRoom(activity) {
      if (activity === 'waiting') return 'meeting';
      return 'office'; // idle, thinking, writing, reading, etc.
    }

    // ─── Room slot positions (tile coords) ───
    // Coffee Room (cols 0-9): 5 couch seats
    const coffeeSlots = [
      { x: 2, y: 5 }, { x: 4, y: 5 }, { x: 6, y: 5 }, { x: 8, y: 5 },
      { x: 5, y: 9 },
    ];
    // Office (cols 10-20): 5 desk seats
    const officeSlots = [
      { x: 12, y: 5 }, { x: 14, y: 5 }, { x: 16, y: 5 }, { x: 18, y: 5 },
      { x: 15, y: 9 },
    ];
    // Meeting Room (cols 21-29): 5 chairs around table
    const meetingSlots = [
      { x: 23, y: 4 }, { x: 25, y: 4 }, { x: 27, y: 4 },
      { x: 24, y: 9 }, { x: 26, y: 9 },
    ];

    const roomSlots = { coffee: coffeeSlots, office: officeSlots, meeting: meetingSlots };

    // ─── Build tile map ───
    // 0=floor, 1=wall, 2=desk, 3=plant, 4=monitor, 5=couch,
    // 6=coffee machine, 7=conference table, 8=whiteboard, 9=door opening
    const tileMap = [];
    for (let y = 0; y < OH; y++) {
      tileMap[y] = [];
      for (let x = 0; x < OW; x++) {
        tileMap[y][x] = 0;
        if (y === 0 || y === OH - 1) tileMap[y][x] = 1;
        if (x === 0 || x === OW - 1) tileMap[y][x] = 1;
        if (x === 10 || x === 21) tileMap[y][x] = 1;
      }
    }
    // Door openings
    tileMap[6][10] = 9; tileMap[7][10] = 9;
    tileMap[6][21] = 9; tileMap[7][21] = 9;

    // Coffee Room furniture
    for (let x = 2; x <= 8; x++) tileMap[4][x] = 5; // top couch
    for (let x = 2; x <= 8; x++) tileMap[8][x] = 5; // bottom couch
    tileMap[1][5] = 6; // coffee machine
    tileMap[2][1] = 3; // plant
    tileMap[11][1] = 3; // plant

    // Office furniture
    for (let x = 12; x <= 18; x += 2) {
      tileMap[3][x] = 4; // monitor top row
      tileMap[4][x] = 2; // desk top row
    }
    for (let x = 12; x <= 18; x += 2) {
      tileMap[10][x] = 2; // desk bottom row
      tileMap[11][x] = 4; // monitor bottom row
    }
    tileMap[1][15] = 3; // lamp/plant

    // Meeting Room furniture
    for (let y = 5; y <= 8; y++) {
      for (let x = 24; x <= 26; x++) tileMap[y][x] = 7;
    }
    tileMap[1][25] = 8; tileMap[1][26] = 8; // whiteboard

    // ─── State ───
    let characters = [];     // all available character data from manager
    let spawnedCharIds = {};  // characterId -> agentId (already spawned)
    let activeAgents = {};    // agentId -> agent object (on canvas, walking between rooms)
    const canvas = document.getElementById('office-canvas');
    const ctx = canvas.getContext('2d');
    let lastTime = 0;
    let animTimer = 0;
    let hoveredEntity = null; // { type: 'char'|'agent', id: string }

    // ─── Canvas resize ───
    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
    window.addEventListener('resize', resize);
    resize();

    function getOfficeOffset() {
      return {
        x: Math.floor((canvas.width - OW * TILE) / 2),
        y: Math.floor((canvas.height - OH * TILE) / 2)
      };
    }

    function getRoomForCol(x) {
      if (x <= 9) return 'coffee';
      if (x <= 20) return 'office';
      return 'meeting';
    }

    // ─── Image loading ───
    const imageCache = {};
    function getCharImage(charData) {
      if (imageCache[charData.id]) return imageCache[charData.id];
      const img = new Image();
      img.src = 'data:' + (charData.mimeType || 'image/png') + ';base64,' + charData.imageData;
      img.onload = () => { imageCache[charData.id] = img; };
      return null;
    }

    function getSlotInRoom(room, slotIdx) {
      const slots = roomSlots[room];
      const idx = slotIdx % slots.length;
      return { x: slots[idx].x * TILE, y: slots[idx].y * TILE };
    }

    // ─── Draw a single tile ───
    function drawTile(px, py, type, tileX) {
      const room = getRoomForCol(tileX);
      const colors = ROOM_COLORS[room];

      switch (type) {
        case 0:
          ctx.fillStyle = colors.floor;
          ctx.fillRect(px, py, TILE, TILE);
          ctx.strokeStyle = colors.floorGrid;
          ctx.strokeRect(px, py, TILE, TILE);
          break;
        case 1:
          ctx.fillStyle = colors.wall;
          ctx.fillRect(px, py, TILE, TILE);
          ctx.fillStyle = colors.wallHighlight;
          ctx.fillRect(px, py, TILE, 3);
          break;
        case 2:
          ctx.fillStyle = colors.floor;
          ctx.fillRect(px, py, TILE, TILE);
          ctx.fillStyle = room === 'office' ? '#4A4870' : '#5C4033';
          ctx.fillRect(px + 2, py + 6, TILE - 4, TILE - 10);
          ctx.fillStyle = 'rgba(255,255,255,0.08)';
          ctx.fillRect(px + 2, py + 6, TILE - 4, 2);
          break;
        case 3:
          ctx.fillStyle = colors.floor;
          ctx.fillRect(px, py, TILE, TILE);
          ctx.fillStyle = '#8B6914';
          ctx.fillRect(px + 10, py + 20, 12, 10);
          ctx.fillStyle = '#4CAF50';
          ctx.beginPath(); ctx.arc(px + 16, py + 14, 10, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#66BB6A';
          ctx.beginPath(); ctx.arc(px + 12, py + 10, 6, 0, Math.PI * 2); ctx.fill();
          break;
        case 4:
          ctx.fillStyle = colors.floor;
          ctx.fillRect(px, py, TILE, TILE);
          ctx.fillStyle = '#2D2C42';
          ctx.fillRect(px + 4, py + 2, 24, 16);
          ctx.fillStyle = 'rgba(127,133,245,0.4)';
          ctx.fillRect(px + 6, py + 4, 20, 12);
          ctx.fillStyle = '#555';
          ctx.fillRect(px + 14, py + 18, 4, 6);
          ctx.fillRect(px + 10, py + 24, 12, 2);
          break;
        case 5:
          ctx.fillStyle = colors.floor;
          ctx.fillRect(px, py, TILE, TILE);
          ctx.fillStyle = '#8B5E3C';
          ctx.fillRect(px + 2, py + 4, TILE - 4, TILE - 8);
          ctx.fillStyle = '#D4956B';
          ctx.fillRect(px + 4, py + 6, TILE - 8, TILE - 14);
          ctx.fillStyle = '#7A4F30';
          ctx.fillRect(px + 1, py + 4, 4, TILE - 8);
          ctx.fillRect(px + TILE - 5, py + 4, 4, TILE - 8);
          break;
        case 6:
          ctx.fillStyle = colors.floor;
          ctx.fillRect(px, py, TILE, TILE);
          ctx.fillStyle = '#333';
          ctx.fillRect(px + 6, py + 4, 20, 24);
          ctx.fillStyle = '#555';
          ctx.fillRect(px + 8, py + 6, 16, 12);
          ctx.fillStyle = '#FF3333';
          ctx.beginPath(); ctx.arc(px + 16, py + 24, 3, 0, Math.PI * 2); ctx.fill();
          const steamY = Math.sin(animTimer * 2) * 2;
          ctx.fillStyle = 'rgba(255,255,255,0.15)';
          ctx.beginPath(); ctx.arc(px + 14, py + steamY, 4, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(px + 18, py - 2 + steamY, 3, 0, Math.PI * 2); ctx.fill();
          break;
        case 7:
          ctx.fillStyle = colors.floor;
          ctx.fillRect(px, py, TILE, TILE);
          ctx.fillStyle = '#2C3E50';
          ctx.fillRect(px + 1, py + 1, TILE - 2, TILE - 2);
          ctx.fillStyle = 'rgba(255,255,255,0.05)';
          ctx.fillRect(px + 1, py + 1, TILE - 2, 2);
          break;
        case 8:
          ctx.fillStyle = colors.wall;
          ctx.fillRect(px, py, TILE, TILE);
          ctx.fillStyle = colors.wallHighlight;
          ctx.fillRect(px, py, TILE, 3);
          ctx.fillStyle = '#E8E8E8';
          ctx.fillRect(px + 3, py + 6, TILE - 6, TILE - 10);
          ctx.fillStyle = 'rgba(100,180,255,0.2)';
          ctx.fillRect(px + 5, py + 8, TILE - 10, 3);
          ctx.fillRect(px + 5, py + 13, TILE - 14, 3);
          ctx.fillRect(px + 5, py + 18, TILE - 12, 3);
          break;
        case 9:
          ctx.fillStyle = colors.floor;
          ctx.fillRect(px, py, TILE, TILE);
          ctx.fillStyle = 'rgba(255,255,255,0.06)';
          ctx.fillRect(px, py, 2, TILE);
          ctx.fillRect(px + TILE - 2, py, 2, TILE);
          break;
      }
    }

    function drawRoomLabels(ox, oy) {
      ctx.font = 'bold 13px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = ROOM_COLORS.coffee.label;
      ctx.fillText('COFFEE ROOM', ox + 5 * TILE, oy - 6);
      ctx.fillStyle = ROOM_COLORS.office.label;
      ctx.fillText('OFFICE', ox + 15.5 * TILE, oy - 6);
      ctx.fillStyle = ROOM_COLORS.meeting.label;
      ctx.fillText('MEETING ROOM', ox + 25.5 * TILE, oy - 6);
    }

    // ─── Draw an unspawned character sitting in Coffee Room ───
    function drawCoffeeCharacter(charData, slotIdx, ox, oy) {
      const slot = coffeeSlots[slotIdx % coffeeSlots.length];
      const S = CHAR_SIZE;
      const px = ox + slot.x * TILE;
      const py = oy + slot.y * TILE;
      const isHovered = hoveredEntity && hoveredEntity.type === 'char' && hoveredEntity.id === charData.id;

      // Store hit box
      charData._px = px; charData._py = py; charData._size = S;

      // Shadow
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.ellipse(px + S / 2, py + S - 2, S / 2 - 4, 5, 0, 0, Math.PI * 2);
      ctx.fill();

      // Hover highlight
      if (isHovered) {
        ctx.save();
        ctx.shadowColor = '#D4A574';
        ctx.shadowBlur = 12;
        ctx.strokeStyle = 'rgba(212,165,116,0.6)';
        ctx.lineWidth = 2;
        ctx.strokeRect(px - 3, py - 3, S + 6, S + 6);
        ctx.restore();
      }

      // Gentle idle bob
      const bob = Math.sin(animTimer * 1.5 + slotIdx * 1.2) * 1.5;

      // Character image
      const img = getCharImage(charData);
      if (img) {
        ctx.drawImage(img, px, py + bob, S, S);
      } else {
        ctx.fillStyle = '#6264A7';
        ctx.beginPath();
        ctx.roundRect(px + 4, py + 4 + bob, S - 8, S - 8, 8);
        ctx.fill();
        ctx.fillStyle = '#FFF';
        ctx.font = 'bold 18px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText((charData.name || 'A')[0], px + S / 2, py + S / 2 + 6 + bob);
      }

      // Name below
      ctx.fillStyle = isHovered ? '#FFF' : '#C8C6C4';
      ctx.font = '11px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(charData.name || 'Agent', px + S / 2, py + S + 14);

      // "Click to start" hint on hover
      if (isHovered) {
        ctx.fillStyle = '#D4A574';
        ctx.font = '10px "Segoe UI", sans-serif';
        ctx.fillText('Click to start', px + S / 2, py + S + 26);
      }
    }

    // ─── Draw a spawned agent ───
    function drawAgent(agentId, agent, ox, oy) {
      const S = CHAR_SIZE;
      const px = ox + agent.currentX;
      const py = oy + agent.currentY;
      const actColor = ACT_COLORS[agent.activity] || '#888';
      const isHovered = hoveredEntity && hoveredEntity.type === 'agent' && hoveredEntity.id === agentId;
      const isWalking = Math.abs(agent.currentX - agent.targetX) > 1 ||
                        Math.abs(agent.currentY - agent.targetY) > 1;

      agent._px = px; agent._py = py; agent._size = S;

      // Shadow
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.ellipse(px + S / 2, py + S - 2, S / 2 - 4, 5, 0, 0, Math.PI * 2);
      ctx.fill();

      // Activity glow ring
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

      // Hover
      if (isHovered) {
        ctx.save();
        ctx.shadowColor = '#FFF';
        ctx.shadowBlur = 10;
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.lineWidth = 2;
        ctx.strokeRect(px - 3, py - 3, S + 6, S + 6);
        ctx.restore();
      }

      // Bob
      const bob = isWalking
        ? Math.sin(animTimer * 10) * 3
        : (agent.activity !== 'idle' ? Math.sin(animTimer * 5) * 2 : 0);

      // Image
      const img = agent.charData ? getCharImage(agent.charData) : null;
      if (img) {
        ctx.drawImage(img, px, py + bob, S, S);
      } else {
        ctx.fillStyle = '#6264A7';
        ctx.beginPath();
        ctx.roundRect(px + 4, py + 4 + bob, S - 8, S - 8, 8);
        ctx.fill();
        ctx.fillStyle = '#FFF';
        ctx.font = 'bold 18px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText((agent.charData?.name || 'A')[0], px + S / 2, py + S / 2 + 6 + bob);
      }

      // Status dot
      ctx.fillStyle = actColor;
      ctx.beginPath();
      ctx.arc(px + S - 4, py + 6, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#1B1A2E';
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
          // Show chain-of-thought snippet (rotates through multiple snippets)
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
          ctx.fillStyle = 'rgba(255,255,255,0.95)';
          ctx.beginPath();
          ctx.moveTo(bx - 5, by + 6);
          ctx.lineTo(bx, by + 13);
          ctx.lineTo(bx + 5, by + 6);
          ctx.fill();
          ctx.fillStyle = '#252440';
          ctx.textAlign = 'center';
          ctx.fillText(text, bx, by);
        }
      }

      // Activity animations (only when stationary)
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
        if (dist < 1) {
          agent.currentX = agent.targetX;
          agent.currentY = agent.targetY;
        } else {
          const step = Math.min(MOVE_SPEED * dt, dist);
          agent.currentX += (dx / dist) * step;
          agent.currentY += (dy / dist) * step;
        }
      }
    }

    // ─── Get unspawned characters (sitting in coffee room) ───
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

      const { x: ox, y: oy } = getOfficeOffset();

      ctx.fillStyle = '#1B1A2E';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      drawRoomLabels(ox, oy);

      // Tiles
      for (let y = 0; y < OH; y++) {
        for (let x = 0; x < OW; x++) {
          drawTile(ox + x * TILE, oy + y * TILE, tileMap[y][x], x);
        }
      }

      // Unspawned characters in Coffee Room
      const available = getAvailableChars();
      for (let i = 0; i < available.length; i++) {
        drawCoffeeCharacter(available[i], i, ox, oy);
      }

      // Spawned agents
      for (const [id, agent] of Object.entries(activeAgents)) {
        drawAgent(id, agent, ox, oy);
      }

      // Empty state
      if (characters.length === 0 && Object.keys(activeAgents).length === 0) {
        ctx.fillStyle = '#555';
        ctx.font = '14px "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Use "Add Custom Character" command to add characters',
          canvas.width / 2, canvas.height / 2);
      }

      requestAnimationFrame(render);
    }

    // ─── Mouse interaction ───
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      hoveredEntity = null;

      // Check unspawned characters in coffee room
      const available = getAvailableChars();
      for (const c of available) {
        const s = c._size || CHAR_SIZE;
        if (c._px !== undefined &&
            mx >= c._px && mx <= c._px + s &&
            my >= c._py && my <= c._py + s) {
          hoveredEntity = { type: 'char', id: c.id };
          canvas.style.cursor = 'pointer';
          return;
        }
      }

      // Check spawned agents
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

    canvas.addEventListener('click', () => {
      if (!hoveredEntity) return;
      if (hoveredEntity.type === 'char') {
        // Click unspawned character -> spawn agent
        vscode.postMessage({ type: 'spawn-agent', characterId: hoveredEntity.id });
      } else if (hoveredEntity.type === 'agent') {
        // Click spawned agent -> focus terminal
        vscode.postMessage({ type: 'click-agent', agentId: hoveredEntity.id });
      }
    });

    // ─── Set agent target position based on activity ───
    function updateAgentTarget(agent) {
      const room = activityToRoom(agent.activity);
      agent.room = room;
      const slot = getSlotInRoom(room, agent.slotIdx);
      agent.targetX = slot.x;
      agent.targetY = slot.y;
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

          // Mark character as spawned
          spawnedCharIds[msg.characterId] = msg.agentId;

          // Find which coffee slot this char was sitting in, use same index for consistency
          const availableBefore = characters.filter(c => c.id !== msg.characterId && !spawnedCharIds[c.id]);
          const charIdx = characters.filter(c => !spawnedCharIds[c.id] || c.id === msg.characterId)
            .findIndex(c => c.id === msg.characterId);
          const slotIdx = Math.max(0, charIdx);

          // Start at Coffee Room position, target = Office
          const coffeePos = getSlotInRoom('coffee', slotIdx);
          const officePos = getSlotInRoom('office', slotIdx);
          activeAgents[msg.agentId] = {
            characterId: msg.characterId,
            charData: charData || null,
            activity: 'idle',
            toolName: '',
            detail: '',
            thought: '',
            slotIdx: slotIdx,
            room: 'office',
            currentX: coffeePos.x,
            currentY: coffeePos.y,
            targetX: officePos.x,
            targetY: officePos.y,
          };
          break;
        }

        case 'agent-activity': {
          const agent = activeAgents[msg.agentId];

          // Agent returned to coffee room (Ctrl+C, /exit, terminal closed)
          if (msg.returned && msg.characterId) {
            if (agent) {
              delete activeAgents[msg.agentId];
            }
            delete spawnedCharIds[msg.characterId];
            break;
          }

          if (agent) {
            agent.activity = msg.activity;
            agent.toolName = msg.toolName || '';
            agent.detail = msg.detail || '';
            // thought is tracked separately so tool activities don't clobber it
            if (msg.thought !== undefined) {
              agent.thought = msg.thought;
            }
            // Clear thought when going idle (turn ended)
            if (msg.activity === 'idle') {
              agent.thought = '';
            }
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
