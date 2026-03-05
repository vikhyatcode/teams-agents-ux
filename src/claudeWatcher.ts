import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export type AgentActivity =
  | "idle"
  | "thinking"
  | "writing"
  | "reading"
  | "running-command"
  | "searching"
  | "researching"
  | "waiting";

export interface AgentEvent {
  agentId: string;
  activity: AgentActivity;
  toolName?: string;
  detail?: string;
  thought?: string;
  /** Set when the agent session has ended (e.g. Ctrl+C) and should return to coffee room. */
  returned?: boolean;
  characterId?: string;
}

export interface TrackedAgent {
  id: string;
  characterId: string;
  terminal: vscode.Terminal;
  sessionId: string;
  jsonlPath: string;
  fileOffset: number;
  lineBuffer: string;
  activity: AgentActivity;
  launchedAt: number;
  lastActivityTime: number;
  idleTimer?: ReturnType<typeof setTimeout>;
  hitlTimer?: ReturnType<typeof setTimeout>;
  staleTimer?: ReturnType<typeof setTimeout>;
  thoughtRotationTimer?: ReturnType<typeof setInterval>;
  turnHasThinking: boolean;
  thoughtSnippets: string[];
  thoughtIndex: number;
  watcher?: fs.FSWatcher;
  pollInterval?: ReturnType<typeof setInterval>;
  watchdogInterval?: ReturnType<typeof setInterval>;
  activeTools: Map<string, string>;
}

const LOG = vscode.window.createOutputChannel("Teams Pixel Agents");

export class ClaudeWatcher {
  private agents = new Map<string, TrackedAgent>();
  private nextId = 1;
  private claudeBaseDir: string;
  private scanInterval?: ReturnType<typeof setInterval>;
  private knownJsonlFiles = new Set<string>();

  private _onAgentActivity = new vscode.EventEmitter<AgentEvent>();
  readonly onAgentActivity = this._onAgentActivity.event;

  constructor(private context: vscode.ExtensionContext) {
    this.claudeBaseDir = path.join(os.homedir(), ".claude", "projects");
    LOG.appendLine(`Claude base dir: ${this.claudeBaseDir}`);
  }

  /** Launch a Claude Code terminal and start tracking it. */
  launchAgent(characterId: string): string {
    const id = `agent-${this.nextId++}`;
    const now = Date.now();

    this.snapshotExistingFiles();

    const terminal = vscode.window.createTerminal({
      name: `Claude Agent #${this.nextId - 1}`,
    });
    terminal.show();
    terminal.sendText("claude");

    const agent: TrackedAgent = {
      id,
      characterId,
      terminal,
      sessionId: "",
      jsonlPath: "",
      fileOffset: 0,
      lineBuffer: "",
      activity: "idle",
      launchedAt: now,
      lastActivityTime: now,
      activeTools: new Map(),
      turnHasThinking: false,
      thoughtSnippets: [],
      thoughtIndex: 0,
    };

    this.agents.set(id, agent);
    LOG.appendLine(`Launched agent ${id} for character ${characterId}`);

    const disposable = vscode.window.onDidCloseTerminal((t) => {
      if (t === terminal) {
        this.returnAgent(agent);
        disposable.dispose();
        LOG.appendLine(`Agent ${id} terminal closed`);
      }
    });
    this.context.subscriptions.push(disposable);

    return id;
  }

  start(): void {
    this.scanInterval = setInterval(() => this.scanForNewTranscripts(), 1000);
    LOG.appendLine("ClaudeWatcher started");
  }

  stop(): void {
    if (this.scanInterval) clearInterval(this.scanInterval);
    for (const agent of this.agents.values()) this.stopWatching(agent);
    this.agents.clear();
  }

  getAgent(id: string): TrackedAgent | undefined {
    return this.agents.get(id);
  }

  private snapshotExistingFiles(): void {
    if (!fs.existsSync(this.claudeBaseDir)) return;
    try {
      for (const projectDir of fs.readdirSync(this.claudeBaseDir)) {
        const fullDir = path.join(this.claudeBaseDir, projectDir);
        if (!fs.statSync(fullDir).isDirectory()) continue;
        for (const file of fs.readdirSync(fullDir)) {
          if (file.endsWith(".jsonl")) {
            this.knownJsonlFiles.add(path.join(fullDir, file));
          }
        }
      }
    } catch {}
    LOG.appendLine(`Snapshot: ${this.knownJsonlFiles.size} existing jsonl files`);
  }

  private scanForNewTranscripts(): void {
    const unattached = Array.from(this.agents.values()).filter((a) => !a.jsonlPath);
    if (unattached.length === 0) return;

    if (!fs.existsSync(this.claudeBaseDir)) return;

    try {
      for (const projectDir of fs.readdirSync(this.claudeBaseDir)) {
        const fullDir = path.join(this.claudeBaseDir, projectDir);
        let stat;
        try { stat = fs.statSync(fullDir); } catch { continue; }
        if (!stat.isDirectory()) continue;

        for (const file of fs.readdirSync(fullDir)) {
          if (!file.endsWith(".jsonl")) continue;
          const fullPath = path.join(fullDir, file);

          if (this.knownJsonlFiles.has(fullPath)) continue;

          const alreadyTracked = Array.from(this.agents.values()).some(
            (a) => a.jsonlPath === fullPath
          );
          if (alreadyTracked) continue;

          let fileMtime;
          try { fileMtime = fs.statSync(fullPath).mtimeMs; } catch { continue; }

          const agent = unattached.find((a) => !a.jsonlPath && fileMtime >= a.launchedAt - 5000);
          if (agent) {
            agent.jsonlPath = fullPath;
            agent.sessionId = path.basename(file, ".jsonl");
            this.startWatching(agent);
            LOG.appendLine(`Attached ${fullPath} to agent ${agent.id}`);
            const idx = unattached.indexOf(agent);
            if (idx >= 0) unattached.splice(idx, 1);
          }
        }
      }
    } catch (e) {
      LOG.appendLine(`Scan error: ${e}`);
    }
  }

  private startWatching(agent: TrackedAgent): void {
    if (!agent.jsonlPath || !fs.existsSync(agent.jsonlPath)) return;

    agent.fileOffset = 0;

    try {
      agent.watcher = fs.watch(agent.jsonlPath, () => this.readNewLines(agent));
    } catch (e) {
      LOG.appendLine(`fs.watch failed for ${agent.jsonlPath}: ${e}`);
    }

    agent.pollInterval = setInterval(() => this.readNewLines(agent), 500);

    // Watchdog: detect Ctrl+C / killed sessions where no end record is written.
    // If agent is non-idle and JSONL hasn't grown for 8s, assume session ended.
    agent.watchdogInterval = setInterval(() => {
      if (agent.activity === "idle") return;
      const elapsed = Date.now() - agent.lastActivityTime;
      if (elapsed < 30000) return;

      try {
        const stat = fs.statSync(agent.jsonlPath);
        if (stat.size <= agent.fileOffset) {
          LOG.appendLine(`[${agent.id}] watchdog: no JSONL activity for ${Math.round(elapsed / 1000)}s while ${agent.activity} -> idle`);
          this.setActivity(agent, "idle");
        }
      } catch {
        // File gone — session definitely ended
        LOG.appendLine(`[${agent.id}] watchdog: JSONL file gone -> returning`);
        this.returnAgent(agent);
      }
    }, 2000);

    LOG.appendLine(`Watching ${agent.jsonlPath} from offset 0`);
  }

  private stopWatching(agent: TrackedAgent): void {
    agent.watcher?.close();
    agent.watcher = undefined;
    if (agent.pollInterval) {
      clearInterval(agent.pollInterval);
      agent.pollInterval = undefined;
    }
    if (agent.watchdogInterval) {
      clearInterval(agent.watchdogInterval);
      agent.watchdogInterval = undefined;
    }
    if (agent.idleTimer) {
      clearTimeout(agent.idleTimer);
      agent.idleTimer = undefined;
    }
    if (agent.hitlTimer) {
      clearTimeout(agent.hitlTimer);
      agent.hitlTimer = undefined;
    }
    if (agent.staleTimer) {
      clearTimeout(agent.staleTimer);
      agent.staleTimer = undefined;
    }
    this.stopThoughtRotation(agent);
  }

  private readNewLines(agent: TrackedAgent): void {
    if (!agent.jsonlPath) return;
    try {
      const stat = fs.statSync(agent.jsonlPath);
      if (stat.size <= agent.fileOffset) return;

      const fd = fs.openSync(agent.jsonlPath, "r");
      const buf = Buffer.alloc(stat.size - agent.fileOffset);
      fs.readSync(fd, buf, 0, buf.length, agent.fileOffset);
      fs.closeSync(fd);
      agent.fileOffset = stat.size;

      const text = agent.lineBuffer + buf.toString("utf-8");
      const lines = text.split("\n");
      agent.lineBuffer = lines.pop() || "";

      for (const line of lines) {
        if (line.trim()) this.processLine(agent, line.trim());
      }
    } catch {}
  }

  private processLine(agent: TrackedAgent, line: string): void {
    try {
      this.processRecord(agent, JSON.parse(line));
    } catch {}
  }

  /** Fire an activity change and manage the idle timeout. */
  private setActivity(
    agent: TrackedAgent,
    activity: AgentActivity,
    toolName?: string,
    detail?: string
  ): void {
    agent.activity = activity;
    agent.lastActivityTime = Date.now();

    // Clear pending idle timer
    if (agent.idleTimer) {
      clearTimeout(agent.idleTimer);
      agent.idleTimer = undefined;
    }

    // Clear stale timer — session is still active
    if (agent.staleTimer) {
      clearTimeout(agent.staleTimer);
      agent.staleTimer = undefined;
    }

    // When leaving thinking, stop the thought rotation
    if (activity !== "thinking") {
      this.stopThoughtRotation(agent);
    }

    const thought = agent.thoughtSnippets.length > 0
      ? agent.thoughtSnippets[agent.thoughtIndex % agent.thoughtSnippets.length]
      : undefined;

    this._onAgentActivity.fire({
      agentId: agent.id,
      activity,
      toolName,
      detail,
      thought,
    });
  }

  /** Extract multiple snippets from a thinking block and start rotating. */
  private startThoughtRotation(agent: TrackedAgent, thought: string): void {
    this.stopThoughtRotation(agent);

    const snippets = this.extractThoughtSnippets(thought);
    if (snippets.length === 0) return;

    agent.thoughtSnippets = snippets;
    agent.thoughtIndex = 0;

    // Fire the first snippet immediately
    this.setActivity(agent, "thinking", undefined, snippets[0]);

    // If there are multiple snippets, rotate through them
    if (snippets.length > 1) {
      agent.thoughtRotationTimer = setInterval(() => {
        agent.thoughtIndex = (agent.thoughtIndex + 1) % agent.thoughtSnippets.length;
        const snippet = agent.thoughtSnippets[agent.thoughtIndex];

        // Only fire if still in a state where thought bubbles make sense
        if (agent.activity !== "idle" && agent.activity !== "waiting") {
          this._onAgentActivity.fire({
            agentId: agent.id,
            activity: agent.activity,
            thought: snippet,
          });
        }
      }, 3000);
    }
  }

  private stopThoughtRotation(agent: TrackedAgent): void {
    if (agent.thoughtRotationTimer) {
      clearInterval(agent.thoughtRotationTimer);
      agent.thoughtRotationTimer = undefined;
    }
  }

  /** Return an agent to the coffee room (session ended or terminal closed). */
  private returnAgent(agent: TrackedAgent): void {
    this.stopWatching(agent);
    const characterId = agent.characterId;
    const agentId = agent.id;
    this.agents.delete(agentId);
    LOG.appendLine(`Agent ${agentId} returned to coffee room (character ${characterId})`);
    this._onAgentActivity.fire({
      agentId,
      activity: "idle",
      returned: true,
      characterId,
    });
  }

  /**
   * Start a HITL timer: if a tool_use has no matching tool_result within
   * ~5 seconds, the user is probably being asked for approval → "waiting".
   */
  private startHitlTimer(agent: TrackedAgent): void {
    // Clear any existing HITL timer
    if (agent.hitlTimer) {
      clearTimeout(agent.hitlTimer);
      agent.hitlTimer = undefined;
    }

    agent.hitlTimer = setTimeout(() => {
      // If tools are still pending (no tool_result arrived), it's HITL
      if (agent.activeTools.size > 0 && agent.activity !== "idle" && agent.activity !== "waiting") {
        agent.activity = "waiting";
        LOG.appendLine(`[${agent.id}] HITL detected -> waiting (pending tools: ${agent.activeTools.size})`);
        this._onAgentActivity.fire({ agentId: agent.id, activity: "waiting" });
      }
    }, 5000);
  }

  private processRecord(agent: TrackedAgent, record: Record<string, unknown>): void {
    const type = record.type as string;
    const message = record.message as Record<string, unknown> | undefined;
    const stopReason = (message?.stop_reason as string | null) ?? null;

    // Log every record for debugging
    LOG.appendLine(
      `[${agent.id}] record: type=${type} subtype=${(record as Record<string, unknown>).subtype || "N/A"} stop_reason=${stopReason}`
    );

    if (type === "assistant") {
      const content = (message?.content as Array<Record<string, unknown>>) || [];
      // Each JSONL record has exactly one content block
      const block = content[0] as Record<string, unknown> | undefined;
      if (!block) return;

      if (block.type === "thinking") {
        agent.turnHasThinking = true;
        const thought = String(block.thinking || "");
        LOG.appendLine(`[${agent.id}] thinking block: ${thought.length} chars`);
        this.startThoughtRotation(agent, thought);
        // stop_reason is null here (more coming), stay in thinking
      } else if (block.type === "tool_use") {
        const toolName = block.name as string;
        const toolId = block.id as string;
        const input = (block.input as Record<string, unknown>) || {};

        agent.activeTools.set(toolId, toolName);
        const activity = this.toolToActivity(toolName);
        const detail = this.getToolDetail(toolName, input);
        LOG.appendLine(`[${agent.id}] ${toolName} -> ${activity} ${detail}`);

        this.setActivity(agent, activity, toolName, detail);

        // Start HITL timer — if tool_result doesn't come back soon,
        // it means user is being asked to approve
        this.startHitlTimer(agent);
      } else if (block.type === "text") {
        if (stopReason === "end_turn") {
          // Final response — turn is done
          LOG.appendLine(`[${agent.id}] assistant text + end_turn -> idle`);
          agent.activeTools.clear();
          this.endTurn(agent);
        } else {
          // Intermediate text (stop_reason is null, more blocks coming)
          // Don't overwrite thought snippets if thinking happened this turn
          if (!agent.turnHasThinking) {
            const text = String(block.text || "");
            const snippet = this.trunc(text.split("\n")[0].trim(), 40);
            if (snippet) {
              this.setActivity(agent, "thinking", undefined, snippet);
            }
          }
          // If turnHasThinking is true, keep the thought rotation running
        }
      }
    } else if (type === "user") {
      const rawContent = message?.content;

      // content can be a plain string (first user message) or an array of blocks
      if (typeof rawContent === "string") {
        // User typed a text message — new turn starting
        this.resetTurn(agent);
        LOG.appendLine(`[${agent.id}] user text message -> thinking`);
        this.setActivity(agent, "thinking");
      } else if (Array.isArray(rawContent)) {
        const content = rawContent as Array<Record<string, unknown>>;
        const hasToolResult = content.some((b) => b.type === "tool_result");

        if (hasToolResult) {
          // Tool result arrived — user approved or tool completed.
          if (agent.hitlTimer) {
            clearTimeout(agent.hitlTimer);
            agent.hitlTimer = undefined;
          }

          for (const block of content) {
            if (block.type === "tool_result") {
              agent.activeTools.delete(block.tool_use_id as string);
            }
          }
          if (agent.activeTools.size === 0) {
            LOG.appendLine(`[${agent.id}] tool_result (all tools done) -> thinking`);
            this.setActivity(agent, "thinking");
          }
        } else {
          // User sent a new message (not a tool result) — new turn starting
          this.resetTurn(agent);
          LOG.appendLine(`[${agent.id}] user array message -> thinking`);
          this.setActivity(agent, "thinking");
        }
      }
    } else if (type === "system") {
      const subtype = record.subtype as string | undefined;
      const event = record.event as string | undefined;
      const key = subtype || event || "";

      if (key === "turn_duration") {
        // Definitive turn end — safety net (end_turn should have fired already)
        LOG.appendLine(`[${agent.id}] turn_duration -> idle`);
        agent.activeTools.clear();
        this.endTurn(agent);

        // Start a stale timer: if no new JSONL activity for 120s,
        // assume the session ended (Ctrl+C / process killed)
        if (agent.staleTimer) clearTimeout(agent.staleTimer);
        agent.staleTimer = setTimeout(() => {
          // Check if the file has grown since we last read it
          try {
            const stat = fs.statSync(agent.jsonlPath);
            if (stat.size <= agent.fileOffset && agent.activity === "idle") {
              LOG.appendLine(`[${agent.id}] stale session detected -> returning to coffee room`);
              this.returnAgent(agent);
            }
          } catch {
            // File gone — definitely ended
            this.returnAgent(agent);
          }
        }, 120000);
      }
      // Detect session end (Ctrl+C, /exit, etc.)
      if (key === "session_end" || key === "exit" || key === "stop") {
        LOG.appendLine(`[${agent.id}] session ended (${key}) -> returning to coffee room`);
        this.returnAgent(agent);
      }
    } else if (type === "progress") {
      // Tool execution progress — ignore, doesn't change state
      LOG.appendLine(`[${agent.id}] progress record (ignored)`);
    } else {
      // Any other record type — log it so we can understand the JSONL format
      LOG.appendLine(`[${agent.id}] unhandled record type: ${type} keys: ${Object.keys(record).join(",")}`);
    }
  }

  /** Reset turn-level state for a new user turn. */
  private resetTurn(agent: TrackedAgent): void {
    agent.turnHasThinking = false;
    agent.thoughtSnippets = [];
    agent.thoughtIndex = 0;
    agent.activeTools.clear();
    this.stopThoughtRotation(agent);
    if (agent.hitlTimer) {
      clearTimeout(agent.hitlTimer);
      agent.hitlTimer = undefined;
    }
  }

  /** End the current turn — set idle and clean up turn state. */
  private endTurn(agent: TrackedAgent): void {
    agent.turnHasThinking = false;
    agent.thoughtSnippets = [];
    agent.thoughtIndex = 0;
    if (agent.hitlTimer) {
      clearTimeout(agent.hitlTimer);
      agent.hitlTimer = undefined;
    }
    this.setActivity(agent, "idle");
  }

  private toolToActivity(toolName: string): AgentActivity {
    switch (toolName) {
      case "Write":
      case "Edit":
      case "NotebookEdit":
        return "writing";
      case "Read":
        return "reading";
      case "Bash":
        return "running-command";
      case "Glob":
      case "Grep":
        return "searching";
      case "WebSearch":
      case "WebFetch":
        return "researching";
      default:
        return toolName.startsWith("mcp") ? "researching" : "thinking";
    }
  }

  private getToolDetail(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case "Write":
      case "Read":
      case "Edit":
        const fp = String(input.file_path || input.path || "");
        return this.trunc(fp.split(/[\\/]/).pop() || fp, 30);
      case "Bash":
        return this.trunc(String(input.command || ""), 30);
      case "Grep":
      case "Glob":
        return this.trunc(String(input.pattern || ""), 30);
      case "WebSearch":
        return this.trunc(String(input.query || ""), 30);
      case "WebFetch":
        return this.trunc(String(input.url || ""), 30);
      default:
        return "";
    }
  }

  /**
   * Extract multiple meaningful snippets from Claude's chain-of-thought.
   * Returns an array of short phrases to rotate through in the UI.
   */
  private extractThoughtSnippets(thought: string): string[] {
    if (!thought) return [];

    const lines = thought.split("\n").map((l) => l.trim()).filter(Boolean);

    const snippets: string[] = [];
    for (const line of lines) {
      // Skip code fences, very short lines, and purely structural lines
      if (line.startsWith("```") || line.length < 10) continue;

      // Clean up markdown artifacts
      const cleaned = line
        .replace(/^[-*#>]+\s*/, "")
        .replace(/`[^`]*`/g, "…")
        .trim();

      if (cleaned.length >= 10) {
        snippets.push(this.trunc(cleaned, 50));
      }
    }

    // Deduplicate and cap at a reasonable number
    const unique = [...new Set(snippets)];
    // Take evenly spaced samples if there are too many
    if (unique.length <= 8) return unique;
    const step = unique.length / 8;
    const sampled: string[] = [];
    for (let i = 0; i < 8; i++) {
      sampled.push(unique[Math.floor(i * step)]);
    }
    return sampled;
  }

  private trunc(s: string, n: number): string {
    return s.length > n ? s.slice(0, n) + "..." : s;
  }
}
