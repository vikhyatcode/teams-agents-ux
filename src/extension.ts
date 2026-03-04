import * as vscode from "vscode";
import { OfficePanel } from "./officePanel";
import { CharacterManager } from "./characterManager";
import { ClaudeWatcher } from "./claudeWatcher";

let officePanel: OfficePanel | undefined;
let characterManager: CharacterManager;
let claudeWatcher: ClaudeWatcher;

export function activate(context: vscode.ExtensionContext) {
  characterManager = new CharacterManager(context);
  claudeWatcher = new ClaudeWatcher(context);
  claudeWatcher.start();

  // Forward activity events to webview
  claudeWatcher.onAgentActivity((event) => {
    officePanel?.postMessage({ type: "agent-activity", ...event });
  });

  // Open the office
  context.subscriptions.push(
    vscode.commands.registerCommand("teamsPixelAgents.openOffice", () => {
      if (officePanel) {
        officePanel.reveal();
      } else {
        officePanel = new OfficePanel(context, characterManager, claudeWatcher);
        officePanel.onDidDispose(() => {
          officePanel = undefined;
        });
      }
    })
  );

  // Add custom character image
  context.subscriptions.push(
    vscode.commands.registerCommand("teamsPixelAgents.addCharacter", async () => {
      const fileUri = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { Images: ["png", "jpg", "jpeg", "gif", "webp"] },
        title: "Select a character image",
      });
      if (!fileUri || fileUri.length === 0) return;

      const name = await vscode.window.showInputBox({
        prompt: "Enter a name for this character",
        placeHolder: "e.g., Clippy, TeamBot",
      });
      if (!name) return;

      await characterManager.addCustomCharacter(name, fileUri[0]);
      vscode.window.showInformationMessage(`Character "${name}" added!`);
      officePanel?.refreshCharacters();
    })
  );
}

export function deactivate() {
  claudeWatcher?.stop();
  officePanel?.dispose();
}
