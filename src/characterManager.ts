import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

export interface CharacterData {
  id: string;
  name: string;
  /** Base64-encoded image data */
  imageData: string;
  /** MIME type of the image */
  mimeType: string;
  /** Is this a built-in character or user-added? */
  isBuiltIn: boolean;
  /** Index into the sprite sheet (0-3), undefined = use SVG fallback */
  spriteIndex?: number;
}

interface CharacterAppearance {
  id: string;
  name: string;
  skin: string;
  hairColor: string;
  hairStyle: "short" | "curly" | "long" | "buzz" | "bun";
  shirtColor: string;
}

const BUILT_IN_APPEARANCES: CharacterAppearance[] = [
  { id: "teams-bot", name: "Teams Bot", skin: "#C68642", hairColor: "#2C1B0E", hairStyle: "short", shirtColor: "#6264A7" },
  { id: "copilot", name: "Copilot", skin: "#FDDBC7", hairColor: "#6B3A2A", hairStyle: "curly", shirtColor: "#7F85F5" },
  { id: "clippy", name: "Clippy", skin: "#D4A06A", hairColor: "#C0392B", hairStyle: "long", shirtColor: "#4CAF50" },
  { id: "t-rex", name: "T-Rex", skin: "#8D5524", hairColor: "#1A1A1A", hairStyle: "buzz", shirtColor: "#FF6B35" },
  { id: "ninja-cat", name: "Ninja Cat", skin: "#B89470", hairColor: "#2C1B0E", hairStyle: "bun", shirtColor: "#E74856" },
];

/**
 * Manages characters (both built-in Teams-themed and user-custom).
 * Custom characters are persisted in extension globalState.
 */
export class CharacterManager {
  private static readonly STORAGE_KEY = "teamsPixelAgents.customCharacters";

  constructor(private context: vscode.ExtensionContext) {}

  /** Get all available characters (built-in + custom) */
  getAllCharacters(): CharacterData[] {
    return [...this.getBuiltInCharacters(), ...this.getCustomCharacters()];
  }

  /** Get built-in Teams-themed characters */
  getBuiltInCharacters(): CharacterData[] {
    return BUILT_IN_APPEARANCES.map((c, i) => ({
      id: c.id,
      name: c.name,
      imageData: this.generateHumanSvg(c),
      mimeType: "image/svg+xml",
      isBuiltIn: true,
      spriteIndex: i < 5 ? i : undefined,
    }));
  }

  /** Get user-added custom characters */
  getCustomCharacters(): CharacterData[] {
    return this.context.globalState.get<CharacterData[]>(
      CharacterManager.STORAGE_KEY,
      []
    );
  }

  /** Add a custom character from a file URI */
  async addCustomCharacter(name: string, fileUri: vscode.Uri): Promise<void> {
    const filePath = fileUri.fsPath;
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
    };
    const mimeType = mimeMap[ext] || "image/png";

    const imageBuffer = fs.readFileSync(filePath);
    const imageData = imageBuffer.toString("base64");

    const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const customs = this.getCustomCharacters();
    customs.push({ id, name, imageData, mimeType, isBuiltIn: false });
    await this.context.globalState.update(CharacterManager.STORAGE_KEY, customs);
  }

  /** Remove a custom character by ID */
  async removeCustomCharacter(id: string): Promise<void> {
    const customs = this.getCustomCharacters().filter((c) => c.id !== id);
    await this.context.globalState.update(CharacterManager.STORAGE_KEY, customs);
  }

  /** Generate a detailed human SVG for built-in characters */
  private generateHumanSvg(appearance: CharacterAppearance): string {
    const { skin, hairColor, hairStyle, shirtColor } = appearance;
    const skinDark = this.darkenColor(skin, 0.15);

    let hairPath = "";
    switch (hairStyle) {
      case "short":
        hairPath = `<ellipse cx="32" cy="16" rx="14" ry="10" fill="${hairColor}"/>
          <rect x="18" y="14" width="28" height="6" rx="2" fill="${hairColor}"/>`;
        break;
      case "curly":
        hairPath = `<ellipse cx="32" cy="14" rx="15" ry="11" fill="${hairColor}"/>
          <circle cx="20" cy="18" r="5" fill="${hairColor}"/>
          <circle cx="44" cy="18" r="5" fill="${hairColor}"/>
          <circle cx="24" cy="12" r="4" fill="${hairColor}"/>
          <circle cx="40" cy="12" r="4" fill="${hairColor}"/>`;
        break;
      case "long":
        hairPath = `<ellipse cx="32" cy="15" rx="15" ry="11" fill="${hairColor}"/>
          <rect x="17" y="15" width="6" height="18" rx="3" fill="${hairColor}"/>
          <rect x="41" y="15" width="6" height="18" rx="3" fill="${hairColor}"/>`;
        break;
      case "buzz":
        hairPath = `<ellipse cx="32" cy="17" rx="13" ry="8" fill="${hairColor}"/>`;
        break;
      case "bun":
        hairPath = `<ellipse cx="32" cy="16" rx="14" ry="9" fill="${hairColor}"/>
          <circle cx="32" cy="8" r="7" fill="${hairColor}"/>`;
        break;
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <rect x="22" y="38" width="20" height="20" rx="4" fill="${shirtColor}"/>
      <rect x="12" y="40" width="12" height="6" rx="3" fill="${shirtColor}"/>
      <rect x="40" y="40" width="12" height="6" rx="3" fill="${shirtColor}"/>
      <circle cx="12" cy="46" r="4" fill="${skin}"/>
      <circle cx="52" cy="46" r="4" fill="${skin}"/>
      <rect x="28" y="32" width="8" height="8" rx="2" fill="${skinDark}"/>
      <ellipse cx="32" cy="24" rx="13" ry="14" fill="${skin}"/>
      <circle cx="21" cy="24" r="3" fill="${skinDark}"/>
      <circle cx="43" cy="24" r="3" fill="${skinDark}"/>
      ${hairPath}
      <ellipse cx="27" cy="24" rx="2" ry="2.5" fill="#1A1A1A"/>
      <ellipse cx="37" cy="24" rx="2" ry="2.5" fill="#1A1A1A"/>
      <circle cx="27.5" cy="23.5" r="0.8" fill="white"/>
      <circle cx="37.5" cy="23.5" r="0.8" fill="white"/>
      <line x1="25" y1="20" x2="29" y2="21" stroke="#1A1A1A" stroke-width="1" stroke-linecap="round"/>
      <line x1="35" y1="21" x2="39" y2="20" stroke="#1A1A1A" stroke-width="1" stroke-linecap="round"/>
      <path d="M28 29 Q32 33 36 29" stroke="#1A1A1A" stroke-width="1.2" fill="none" stroke-linecap="round"/>
    </svg>`;

    return Buffer.from(svg).toString("base64");
  }

  private darkenColor(hex: string, amount: number): string {
    const num = parseInt(hex.slice(1), 16);
    const r = Math.max(0, ((num >> 16) & 0xff) * (1 - amount));
    const g = Math.max(0, ((num >> 8) & 0xff) * (1 - amount));
    const b = Math.max(0, (num & 0xff) * (1 - amount));
    return `#${((1 << 24) + (Math.round(r) << 16) + (Math.round(g) << 8) + Math.round(b)).toString(16).slice(1)}`;
  }
}
