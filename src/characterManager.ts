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
}

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
    // Built-in characters are simple colored circles with labels,
    // generated as tiny inline SVGs so no external assets are needed.
    const builtIns = [
      { id: "teams-bot", name: "Teams Bot", color: "#6264A7" },
      { id: "copilot", name: "Copilot", color: "#7F85F5" },
      { id: "clippy", name: "Clippy", color: "#4CAF50" },
      { id: "t-rex", name: "T-Rex", color: "#FF6B35" },
      { id: "ninja-cat", name: "Ninja Cat", color: "#E74856" },
    ];

    return builtIns.map((c) => ({
      id: c.id,
      name: c.name,
      imageData: this.generatePlaceholderSvg(c.name, c.color),
      mimeType: "image/svg+xml",
      isBuiltIn: true,
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

  /** Generate a simple SVG placeholder for built-in characters */
  private generatePlaceholderSvg(name: string, color: string): string {
    const initials = name
      .split(" ")
      .map((w) => w[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="8" fill="${color}"/>
      <text x="32" y="38" text-anchor="middle" fill="white" font-family="Segoe UI, sans-serif" font-size="20" font-weight="bold">${initials}</text>
    </svg>`;

    return Buffer.from(svg).toString("base64");
  }
}
