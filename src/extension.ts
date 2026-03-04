import * as vscode from "vscode";
import { OfficePanel } from "./officePanel";
import { CharacterManager } from "./characterManager";

let officePanel: OfficePanel | undefined;
let characterManager: CharacterManager;

export function activate(context: vscode.ExtensionContext) {
  characterManager = new CharacterManager(context);

  // Command: Open the office view
  context.subscriptions.push(
    vscode.commands.registerCommand("teamsPixelAgents.openOffice", () => {
      if (officePanel) {
        officePanel.reveal();
      } else {
        officePanel = new OfficePanel(context, characterManager);
        officePanel.onDidDispose(() => {
          officePanel = undefined;
        });
      }
    })
  );

  // Command: Add a custom character from an image file
  context.subscriptions.push(
    vscode.commands.registerCommand("teamsPixelAgents.addCharacter", async () => {
      const fileUri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { Images: ["png", "jpg", "jpeg", "gif", "webp"] },
        title: "Select a character image",
      });

      if (!fileUri || fileUri.length === 0) {
        return;
      }

      const name = await vscode.window.showInputBox({
        prompt: "Enter a name for this character",
        placeHolder: "e.g., Clippy, T-Rex, TeamBot",
      });

      if (!name) {
        return;
      }

      await characterManager.addCustomCharacter(name, fileUri[0]);
      vscode.window.showInformationMessage(
        `Character "${name}" added! Open the office to see them.`
      );

      // Notify the webview if it's open
      if (officePanel) {
        officePanel.refreshCharacters();
      }
    })
  );

  // Auto-open on startup (optional, can be removed)
  vscode.window.showInformationMessage(
    'Teams Pixel Agents ready! Run "Teams Pixel Agents: Open Office" to start.',
  );
}

export function deactivate() {
  officePanel?.dispose();
}
