import * as vscode from "vscode";
import { OfficePanel } from "./officePanel";
import { CharacterManager } from "./characterManager";
import { ClaudeWatcher } from "./claudeWatcher";
import { TeamsWatcher } from "./teamsWatcher";
import { TeamsSummarizer } from "./teamsSummarizer";

let characterManager: CharacterManager;
let claudeWatcher: ClaudeWatcher;
let teamsWatcher: TeamsWatcher;
let teamsSummarizer: TeamsSummarizer;

export function activate(context: vscode.ExtensionContext) {
  characterManager = new CharacterManager(context);
  claudeWatcher = new ClaudeWatcher(context);
  claudeWatcher.start();

  teamsWatcher = new TeamsWatcher(context);
  teamsSummarizer = new TeamsSummarizer();

  const officePanel = new OfficePanel(context, characterManager, claudeWatcher);

  // Register as bottom panel webview provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      OfficePanel.viewType,
      officePanel,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Forward activity events to webview
  claudeWatcher.onAgentActivity((event) => {
    officePanel.postMessage({ type: "agent-activity", ...event });
  });

  // Forward Teams status to webview
  teamsWatcher.onStatusChange((status) => {
    officePanel.postMessage({ type: "teams-status", status });
  });

  // Forward Teams messages: summarize then notify
  teamsWatcher.onManagerMessage(async (msg) => {
    const summary = await teamsSummarizer.summarize(msg.body);

    // VS Code notification
    const action = await vscode.window.showInformationMessage(
      `\u{1F4E9} ${msg.senderName}: ${summary}`,
      "Open Chat"
    );
    if (action === "Open Chat") {
      vscode.env.openExternal(
        vscode.Uri.parse(
          `https://teams.microsoft.com/l/chat/${msg.chatId}/0`
        )
      );
    }

    // Post to webview
    officePanel.postMessage({
      type: "manager-message",
      senderName: msg.senderName,
      summary,
      timestamp: msg.timestamp,
      chatId: msg.chatId,
    });
  });

  // Open/focus the office panel
  context.subscriptions.push(
    vscode.commands.registerCommand("teamsPixelAgents.openOffice", () => {
      // Use the built-in command to focus the webview view by its ID
      vscode.commands.executeCommand("teamsPixelAgents.officeView.focus");
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
      officePanel.refreshCharacters();
    })
  );

  // Connect to Teams
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "teamsPixelAgents.connectTeams",
      async () => {
        const token = await vscode.window.showInputBox({
          prompt:
            "Paste your Graph API token (from Graph Explorer — needs Chat.Read, User.Read, User.Read.All)",
          placeHolder: "eyJ0eXAi...",
          password: true,
          ignoreFocusOut: true,
        });
        if (!token) return;
        await teamsWatcher.start(token);
      }
    )
  );

  // Disconnect from Teams
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "teamsPixelAgents.disconnectTeams",
      () => {
        teamsWatcher.stop();
        vscode.window.showInformationMessage("Disconnected from Teams.");
      }
    )
  );
}

export function deactivate() {
  claudeWatcher?.stop();
  teamsWatcher?.dispose();
}
