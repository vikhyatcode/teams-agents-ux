import * as vscode from "vscode";

export interface ManagerMessage {
  id: string;
  senderName: string;
  body: string; // HTML-stripped, first 300 chars
  timestamp: string; // ISO 8601
  chatId: string;
}

export type TeamsMonitorStatus =
  | "connected"
  | "disconnected"
  | "error"
  | "no-manager";

interface ManagerInfo {
  displayName: string;
  id: string;
  fetchedAt: number;
}

interface GraphChatMessage {
  id: string;
  body?: { contentType?: string; content?: string };
  from?: { user?: { displayName?: string; id?: string } };
  createdDateTime?: string;
}

export class TeamsWatcher {
  private token: string | null = null;
  private managerInfo: ManagerInfo | null = null;
  private managerChatId: string | null = null;
  private lastSeenMessageId: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private backoffMs = 0;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private webviewVisible = true;

  private _onManagerMessage = new vscode.EventEmitter<ManagerMessage>();
  readonly onManagerMessage = this._onManagerMessage.event;

  private _onStatusChange = new vscode.EventEmitter<TeamsMonitorStatus>();
  readonly onStatusChange = this._onStatusChange.event;

  private status: TeamsMonitorStatus = "disconnected";

  constructor(private context: vscode.ExtensionContext) {
    this.lastSeenMessageId =
      context.globalState.get<string>("teamsLastSeenMsgId") ?? null;
  }

  async start(token: string) {
    this.token = token;
    this.backoffMs = 0;
    this.setStatus("connected");

    // Resolve manager
    try {
      await this.resolveManager();
    } catch {
      this.setStatus("no-manager");
      vscode.window.showWarningMessage(
        "Could not resolve your manager from Graph API. Check permissions (User.Read.All)."
      );
      return;
    }

    // Resolve 1:1 chat with manager
    try {
      await this.resolveManagerChat();
    } catch {
      this.setStatus("error");
      vscode.window.showWarningMessage(
        "Could not find a 1:1 chat with your manager. Make sure you have chatted with them."
      );
      return;
    }

    this.setStatus("connected");
    this.startPolling();
  }

  stop() {
    this.token = null;
    this.clearTimers();
    this.setStatus("disconnected");
  }

  setWebviewVisible(visible: boolean) {
    this.webviewVisible = visible;
    // Restart polling with new interval if currently running
    if (this.token && this.status === "connected") {
      this.startPolling();
    }
  }

  isActive(): boolean {
    return this.token !== null && this.status === "connected";
  }

  getStatus(): TeamsMonitorStatus {
    return this.status;
  }

  private setStatus(s: TeamsMonitorStatus) {
    this.status = s;
    this._onStatusChange.fire(s);
  }

  private clearTimers() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
  }

  private getPollingInterval(): number {
    const configMs =
      (vscode.workspace
        .getConfiguration("teamsPixelAgents")
        .get<number>("teamsPollingInterval") ?? 60) * 1000;
    return this.webviewVisible ? configMs : Math.max(configMs, 5 * 60 * 1000);
  }

  private startPolling() {
    this.clearTimers();
    const interval = this.getPollingInterval();
    // Poll immediately once, then on interval
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), interval);
  }

  private async poll() {
    if (!this.token || !this.managerChatId) return;

    try {
      const messages = await this.fetchRecentMessages();
      this.backoffMs = 0; // Reset backoff on success

      if (messages.length === 0) return;

      // Process new messages (newest first from API, iterate oldest first)
      for (const msg of messages.reverse()) {
        if (this.lastSeenMessageId && msg.id <= this.lastSeenMessageId) continue;
        // Only messages FROM the manager
        if (msg.from?.user?.id !== this.managerInfo?.id) continue;

        const body = this.stripHtml(msg.body?.content ?? "").slice(0, 300);
        if (!body.trim()) continue;

        const managerMsg: ManagerMessage = {
          id: msg.id,
          senderName: msg.from?.user?.displayName ?? this.managerInfo?.displayName ?? "Manager",
          body,
          timestamp: msg.createdDateTime ?? new Date().toISOString(),
          chatId: this.managerChatId!,
        };

        this._onManagerMessage.fire(managerMsg);
      }

      // Update last seen to newest message id
      const newestId = messages[0]?.id;
      if (newestId) {
        this.lastSeenMessageId = newestId;
        await this.context.globalState.update("teamsLastSeenMsgId", newestId);
      }
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      if (status === 401) {
        this.setStatus("error");
        this.clearTimers();
        const action = await vscode.window.showWarningMessage(
          "Teams token expired. Paste a new token to continue monitoring.",
          "Reconnect"
        );
        if (action === "Reconnect") {
          vscode.commands.executeCommand("teamsPixelAgents.connectTeams");
        }
        return;
      }
      if (status === 429) {
        this.applyBackoff();
        return;
      }
      // Other errors — apply backoff
      this.applyBackoff();
    }
  }

  private applyBackoff() {
    this.clearTimers();
    if (this.backoffMs === 0) {
      this.backoffMs = 2 * 60 * 1000; // 2 min
    } else {
      this.backoffMs = Math.min(this.backoffMs * 2, 15 * 60 * 1000); // cap 15 min
    }
    this.backoffTimer = setTimeout(() => {
      this.startPolling();
    }, this.backoffMs);
  }

  private async resolveManager() {
    // Cache for 1 hour
    if (
      this.managerInfo &&
      Date.now() - this.managerInfo.fetchedAt < 60 * 60 * 1000
    ) {
      return;
    }

    const resp = await this.graphGet("/me/manager");
    this.managerInfo = {
      displayName: resp.displayName,
      id: resp.id,
      fetchedAt: Date.now(),
    };
  }

  private async resolveManagerChat() {
    if (this.managerChatId) return;

    const resp = await this.graphGet(
      "/me/chats?$filter=chatType eq 'oneOnOne'&$expand=members&$top=50"
    );
    const chats: Array<{
      id: string;
      members?: Array<{ userId?: string }>;
    }> = resp.value ?? [];

    for (const chat of chats) {
      const members = chat.members ?? [];
      if (
        members.some(
          (m: { userId?: string }) => m.userId === this.managerInfo?.id
        )
      ) {
        this.managerChatId = chat.id;
        return;
      }
    }

    throw new Error("Manager chat not found");
  }

  private async fetchRecentMessages(): Promise<GraphChatMessage[]> {
    const resp = await this.graphGet(
      `/me/chats/${this.managerChatId}/messages?$top=5`
    );
    return resp.value ?? [];
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private async graphGet(path: string): Promise<any> {
    const url = `https://graph.microsoft.com/v1.0${path}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!resp.ok) {
      const err: any = new Error(`Graph API ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  }

  dispose() {
    this.stop();
    this._onManagerMessage.dispose();
    this._onStatusChange.dispose();
  }
}
