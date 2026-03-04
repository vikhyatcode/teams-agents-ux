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
  thoughtSnippets: string[];
  thoughtIndex: number;
  watcher?: fs.FSWatcher;
  pollInterval?: ReturnType<typeof setInterval>;
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
    LOG.appendLine(`Watching ${agent.jsonlPath} from offset 0`);
  }

  private stopWatching(agent: TrackedAgent): void {
    agent.watcher?.close();
    agent.watcher = undefined;
    if (agent.pollInterval) {
      clearInterval(agent.pollInterval);
      agent.pollInterval = undefined;
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

    // Log every record type for debugging
    LOG.appendLine(`[${agent.id}] record: type=${type} subtype=${(record as Record<string, unknown>).subtype || "N/A"}`);

    if (type === "assistant") {
      const message = record.message as Record<string, unknown> | undefined;
      const content = (message?.content as Array<Record<string, unknown>>) || [];

      let hasThinkingBlock = false;
      let hasToolUse = false;
      let hasText = false;

      for (const block of content) {
        if (block.type === "tool_use") {
          hasToolUse = true;
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
        }
        if (block.type === "thinking") {
          // Chain-of-thought block — extract snippets and rotate through them
          hasThinkingBlock = true;
          const thought = String(block.thinking || "");
          LOG.appendLine(`[${agent.id}] thinking block: ${thought.length} chars`);
          this.startThoughtRotation(agent, thought);
        }
        if (block.type === "text") {
          hasText = true;
          const text = String(block.text || "");
          const snippet = this.trunc(text.split("\n")[0].trim(), 40);
          if (agent.activity === "idle" || agent.activity === "waiting") {
            this.setActivity(agent, "thinking", undefined, snippet);
          } else if (agent.activity === "thinking" && !hasThinkingBlock) {
            // Only use response text as detail if there was no thinking block
            // in this message — otherwise keep the chain-of-thought snippet
            this.setActivity(agent, "thinking", undefined, snippet);
          }
        }
      }

      // If the assistant message has text but NO tool_use, the turn is
      // finishing — Claude is outputting its final response. Start an idle
      // timer as a fallback in case turn_duration never arrives.
      if (hasText && !hasToolUse) {
        LOG.appendLine(`[${agent.id}] assistant text-only message -> scheduling idle fallback`);
        if (agent.idleTimer) clearTimeout(agent.idleTimer);
        agent.idleTimer = setTimeout(() => {
          if (agent.activity === "thinking") {
            LOG.appendLine(`[${agent.id}] idle fallback fired -> idle`);
            agent.activeTools.clear();
            this.setActivity(agent, "idle");
          }
        }, 3000);
      }
    } else if (type === "user") {
      const message = record.message as Record<string, unknown> | undefined;
      const rawContent = message?.content;

      // content can be a plain string (first user message) or an array of blocks
      if (typeof rawContent === "string") {
        // User typed a text message — new turn starting
        agent.activeTools.clear();
        if (agent.hitlTimer) {
          clearTimeout(agent.hitlTimer);
          agent.hitlTimer = undefined;
        }
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
            this.setActivity(agent, "thinking");
          }
        } else {
          // User sent a new message (not a tool result) — new turn starting
          agent.activeTools.clear();
          if (agent.hitlTimer) {
            clearTimeout(agent.hitlTimer);
            agent.hitlTimer = undefined;
          }
          LOG.appendLine(`[${agent.id}] user array message -> thinking`);
          this.setActivity(agent, "thinking");
        }
      }
    } else if (type === "system") {
      const subtype = record.subtype as string;
      if (subtype === "turn_duration") {
        // Claude's turn is over — agent goes back to idle (at desk)
        agent.activeTools.clear();
        if (agent.hitlTimer) {
          clearTimeout(agent.hitlTimer);
          agent.hitlTimer = undefined;
        }
        LOG.appendLine(`[${agent.id}] turn ended -> idle`);
        this.setActivity(agent, "idle");

        // Start a stale timer: if no new JSONL activity for 10s,
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
        }, 10000);
      }
      // Detect session end (Ctrl+C, /exit, etc.)
      if (subtype === "session_end" || subtype === "exit") {
        LOG.appendLine(`[${agent.id}] session ended (${subtype}) -> returning to coffee room`);
        this.returnAgent(agent);
      }
    }
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
      case "WebSearch":
      case "WebFetch":
        return "searching";
      default:
        return "thinking";
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
