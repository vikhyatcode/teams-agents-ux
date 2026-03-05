import * as vscode from "vscode";

export class TeamsSummarizer {
  private apiKey: string | null = null;

  constructor() {
    this.refreshApiKey();
  }

  private refreshApiKey() {
    this.apiKey =
      vscode.workspace
        .getConfiguration("teamsPixelAgents")
        .get<string>("anthropicApiKey") ||
      process.env.ANTHROPIC_API_KEY ||
      null;
  }

  async summarize(body: string): Promise<string> {
    this.refreshApiKey();

    if (!this.apiKey) {
      return this.fallback(body);
    }

    try {
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const client = new Anthropic({ apiKey: this.apiKey });

      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 100,
        system:
          "Summarize this Teams message from my manager in one concise sentence. Be direct and actionable.",
        messages: [{ role: "user", content: body }],
      });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("");

      return text || this.fallback(body);
    } catch {
      return this.fallback(body);
    }
  }

  private fallback(body: string): string {
    const preview = body.slice(0, 80);
    return preview.length < body.length ? preview + "..." : preview;
  }
}
