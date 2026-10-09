import {
  ItemView,
  TFile,
  MarkdownRenderer,
  Notice,
  WorkspaceLeaf,
  normalizePath,
} from "obsidian";
import type ClaudeCodeSkillsPlugin from "./main";
import type { Skill } from "./types";
import { runWithSkillStreaming, type TurnStats } from "./executor";
import {
  type Attachment,
  attachmentsPreamble,
  buildCard,
  kindOf,
  resolveVaultPath,
} from "./attachments";

export const CLAUDE_PANEL_VIEW_TYPE = "claude-skills-chat";

/**
 * Sent once at the start of a session. Claude Code reads files by line number
 * and will happily answer "see line 153", which is no use in Obsidian: the
 * reader sees rendered prose with no line numbers and nothing to click.
 */
const CITING_PLACES =
  "How to point me at somewhere in my vault: give a link I can click, " +
  "[[Note name#Heading]], or [[Note name]] with the sentence quoted so I can " +
  "search for it. Never cite a line number - Obsidian does not show them, so " +
  "I cannot find what you mean.\n\n---\n\n";

/** How close to the bottom still counts as "following along", in pixels. */
const STICK_THRESHOLD_PX = 40;

export class ClaudePanel extends ItemView {
  plugin: ClaudeCodeSkillsPlugin;

  private sessionId: string | null = null;
  private cancelFn: (() => void) | null = null;
  private isStreaming = false;
  private lastResponseText = "";
  private conversationLog: string[] = []; // full transcript for Create Note
  private activeSkillName: string | null = null;
  private hasFirstChunk = false;
  // False once the reader has scrolled up: streaming text must not drag
  // the view back down while they are reading something further up.
  private stickToBottom = true;

  // DOM refs
  private messagesEl!: HTMLElement;
  private skillLabelEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private loadingEl: HTMLElement | null = null;
  private currentStreamPre: HTMLPreElement | null = null;
  private currentStreamContainer: HTMLElement | null = null;
  private attachments: Attachment[] = [];
  private attachTray!: HTMLElement;
  private queue: string[] = [];
  private focusBtn!: HTMLButtonElement;
  private queueEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: ClaudeCodeSkillsPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return CLAUDE_PANEL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Claude";
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("claude-panel-root");

    // ── Session bar ──────────────────────────────────────────────────────────
    const sessionBar = contentEl.createDiv({ cls: "claude-panel-session-bar" });
    this.skillLabelEl = sessionBar.createDiv({ cls: "claude-panel-skill-label" });
    this.skillLabelEl.setText("No active session");

    // Focused mode: answer only from what was dragged in.
    this.focusBtn = sessionBar.createEl("button", { cls: "claude-focus-toggle" });
    this.focusBtn.addEventListener("click", () => {
      this.plugin.settings.focusedMode = !this.plugin.settings.focusedMode;
      void this.plugin.saveSettings();
      this.updateFocusToggle();
      new Notice(
        this.plugin.settings.focusedMode
          ? "Only what you drag in - no access to the vault"
          : "Full access to the vault"
      );
      this.resetSession();   // the mode changes what the session can do
    });
    this.updateFocusToggle();

    // ── Messages area ────────────────────────────────────────────────────────
    this.messagesEl = contentEl.createDiv({ cls: "claude-panel-messages" });

    // Any scroll that leaves the bottom hands control to the reader; scrolling
    // back to the bottom takes it back, so following along needs no button.
    this.registerDomEvent(this.messagesEl, "scroll", () => {
      const distance =
        this.messagesEl.scrollHeight -
        this.messagesEl.scrollTop -
        this.messagesEl.clientHeight;
      this.stickToBottom = distance <= STICK_THRESHOLD_PX;
    });

    // ── Footer ───────────────────────────────────────────────────────────────
    const footer = contentEl.createDiv({ cls: "claude-panel-footer" });

    // Attachment tray: whatever has been dragged in, waiting to be sent
    this.attachTray = footer.createDiv({ cls: "claude-attach-tray" });
    this.setupDropTarget(this.containerEl, contentEl);
    this.renderAttachments();

    // Input row
    const inputRow = footer.createDiv({ cls: "claude-panel-input-row" });
    this.inputEl = inputRow.createEl("textarea", {
      cls: "claude-panel-input",
      attr: { placeholder: "Ask a follow-up... (Enter to send, Shift+Enter for newline)" },
    });

    this.sendBtn = inputRow.createEl("button", {
      cls: "claude-panel-send-btn",
      text: "→",
    });

    this.sendBtn.addEventListener("click", () => {
      if (this.isStreaming) this.stopStreaming();
      else this.handleSend();
    });
    this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      // While an IME is composing - pinyin, kana, any of them - Enter confirms
      // the candidate and must not send. The flag is set by the browser for
      // exactly this; keyCode 229 is the older spelling of it.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
        return;
      }
      if (e.key === "Escape" && this.isStreaming) {
        e.preventDefault();
        this.stopStreaming();
      }
    });

    // How many messages are waiting behind the one being answered.
    this.queueEl = footer.createDiv({ cls: "claude-queue-hint" });
    this.updateQueueHint();

    // Action row
    const actionRow = footer.createDiv({ cls: "claude-panel-action-row" });

    const copyBtn = actionRow.createEl("button", { text: "Copy last" });
    copyBtn.addEventListener("click", () => {
      if (this.lastResponseText) {
        navigator.clipboard.writeText(this.lastResponseText)
          .then(() => new Notice("Copied to clipboard"))
          .catch(() => new Notice("Copy failed — check clipboard permissions"));
      }
    });

    const createNoteBtn = actionRow.createEl("button", { text: "Create note" });
    createNoteBtn.addEventListener("click", () => void this.createNote());

    const closeBtn = actionRow.createEl("button", {
      cls: "claude-close-session-btn",
      text: "Close session",
    });
    closeBtn.addEventListener("click", () => this.closeSession());

    this.updateInputState();
  }

  async onClose(): Promise<void> {
    this.cancelFn?.();
    this.cancelFn = null;
  }

  // ── Public entry points ────────────────────────────────────────────────────

  /**
   * Called from context menu: starts a new conversation with the given skill
   * and selected text. Adds a visual separator if a previous session exists.
   */
  startConversation(skill: Skill, selectedText: string): void {
    if (!this.messagesEl) return; // onOpen not yet called

    this.queue = [];
    this.updateQueueHint();
    this.cancelFn?.(); // kill any in-progress stream
    this.isStreaming = false;

    // If there were prior messages, add a separator
    const hasHistory = this.messagesEl.childElementCount > 0;
    if (hasHistory) {
      this.messagesEl.createEl("hr", { cls: "claude-panel-separator" });
    }

    this.sessionId = null; // start a fresh session
    this.conversationLog = []; // new conversation = fresh transcript
    this.activeSkillName = skill.name;
    this.skillLabelEl.setText(`Skill: ${skill.name}`);

    // Show a truncated preview of the selected text as the "user" bubble
    const preview = selectedText.length > 300
      ? selectedText.slice(0, 300) + "…"
      : selectedText;
    this.addUserBubble(preview);

    this.send(skill.id, selectedText);
  }

  /**
   * Called from ribbon/command palette: opens the panel in freeform chat mode.
   * The user types a message in the input box.
   */
  startFreeform(): void {
    if (!this.messagesEl) return;
    this.skillLabelEl.setText(this.sessionId ? "Chat (session active)" : "Chat");
    this.inputEl?.focus();
  }

  // ── Internal send / stream ─────────────────────────────────────────────────

  private handleSend(): void {
    const text = this.inputEl.value.trim();
    const atts = this.attachments;
    if (!text && !atts.length) return;
    this.inputEl.value = "";
    this.addUserMessage(text, atts);
    this.attachments = [];
    this.renderAttachments();

    void this.composePayload(text, atts).then((payload) => {
      if (this.isStreaming) {
        this.queue.push(payload);
        this.updateQueueHint();
        return;
      }
      this.send(null, payload); // null skillId = follow-up / freeform
    });
  }

  private updateFocusToggle(): void {
    if (!this.focusBtn) return;
    const on = this.plugin.settings.focusedMode;
    this.focusBtn.setText(on ? "only what I drag in" : "whole vault");
    this.focusBtn.toggleClass("is-focused", on);
    this.focusBtn.setAttr(
      "aria-label",
      on
        ? "Answers come only from what you drag in. Click for full vault access."
        : "Claude may read and search the vault. Click to limit it to what you drag in."
    );
  }

  /**
   * In focused mode the CLI has no tools at all, so anything dragged in has to
   * travel with the message: a dragged note is read here and inlined, rather
   * than passed as a path for Claude to open.
   */
  private async composePayload(text: string, atts: Attachment[]): Promise<string> {
    const question = text || "Explain what I attached.";
    if (!this.plugin.settings.focusedMode) {
      return attachmentsPreamble(atts) + question;
    }

    let out =
      "Answer only from the material below. You have no access to my vault and " +
      "no tools: this is everything you have. If the answer is not in it, say so " +
      "plainly instead of guessing.\n\n";

    for (let i = 0; i < atts.length; i++) {
      const att = atts[i];
      const n = i + 1;
      if (att.kind === "text") {
        out += `--- [${n}] selected in "${att.source}" ---\n\n${att.text}\n\n`;
        continue;
      }
      const file = await this.readVaultText(att.path);
      if (file) {
        out += `--- [${n}] note: ${file.path} ---\n\n${file.content}\n\n`;
      } else {
        out += `--- [${n}] ${att.path} - not included: it is not a text file in ` +
               `this vault, and in this mode I cannot open files for you ---\n\n`;
      }
    }

    return out + "---\n\n" + question;
  }

  /** Reads a dragged file back out of the vault, if it is text. */
  private async readVaultText(absPath: string): Promise<{ path: string; content: string } | null> {
    try {
      const adapter = this.app.vault.adapter as unknown as { basePath?: string };
      const base = adapter.basePath ?? "";
      if (!base || !absPath.startsWith(base + "/")) return null;
      const rel = absPath.slice(base.length + 1);
      const file = this.app.vault.getAbstractFileByPath(rel);
      if (!(file instanceof TFile)) return null;
      const readable = ["md", "txt", "csv", "json", "js", "ts", "py", "css", "html", "svg", "yml", "yaml"];
      if (!readable.includes(file.extension)) return null;
      return { path: rel, content: await this.app.vault.cachedRead(file) };
    } catch {
      return null;
    }
  }

  // ── Dragged-in attachments ─────────────────────────────────────────────────

  /**
   * Accepts drops anywhere in the panel. The listeners are in the capture
   * phase on the whole leaf, because the textarea would otherwise swallow
   * dropped text before it ever reached us.
   */
  private setupDropTarget(rootEl: HTMLElement, paintEl: HTMLElement): void {
    const stop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const over = (e: DragEvent) => {
      stop(e);
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      paintEl.addClass("claude-drop-active");
    };

    rootEl.addEventListener("dragenter", over, true);
    rootEl.addEventListener("dragover", over, true);
    rootEl.addEventListener("dragleave", (e: DragEvent) => {
      if (!rootEl.contains(e.relatedTarget as Node)) paintEl.removeClass("claude-drop-active");
    }, true);

    rootEl.addEventListener("drop", (e: DragEvent) => {
      stop(e);
      paintEl.removeClass("claude-drop-active");
      const dt = e.dataTransfer;
      if (!dt) return;

      // A file from Finder or the file explorer
      if (dt.files && dt.files.length) {
        Array.from(dt.files).forEach((f) => {
          const p = (f as File & { path?: string }).path ?? f.name;
          this.addAttachment({ kind: kindOf(p), label: p.split("/").pop() ?? p, path: p });
        });
        return;
      }

      const html = dt.getData("text/html") || "";
      const uri = dt.getData("text/uri-list") || "";
      const text = (dt.getData("text/plain") || "").replace(/\s+$/, "");

      // An embed dragged out of a note: ![[some image.png]]
      const link = text.trim().match(/^!?\[\[([^\]|]+)(\|[^\]]*)?\]\]$/);
      if (link) {
        const p = resolveVaultPath(this.app, link[1].trim());
        if (p) {
          this.addAttachment({ kind: kindOf(p), label: p.split("/").pop() ?? p, path: p });
          return;
        }
      }

      // A rendered image
      const img = html.match(/<img[^>]+src="([^"]+)"/i);
      const src = (img && img[1]) || uri;
      if (src && !text.trim()) {
        const p = resolveVaultPath(this.app, src);
        if (p) {
          this.addAttachment({ kind: kindOf(p), label: p.split("/").pop() ?? p, path: p });
          return;
        }
      }

      // A note dragged from its tab header or from the file explorer arrives
      // as an obsidian:// URL sitting in text/plain. Attaching that verbatim
      // handed Claude a link and nothing else to read.
      const asLink = (uri || text).trim();
      if (!asLink.includes("\n") && /^(obsidian|app|file):\/\//.test(asLink)) {
        const p = resolveVaultPath(this.app, asLink);
        if (p) {
          this.addAttachment({ kind: kindOf(p), label: p.split("/").pop() ?? p, path: p });
          return;
        }
      }

      if (text.trim()) this.attachText(text);
    }, true);
  }

  /** Attaches a passage of text. Called by the drop handler and from main.ts. */
  attachText(text: string, sourceName?: string): void {
    const source = sourceName ?? this.describeSource();
    const first = text.split("\n").find((l) => l.trim()) ?? text;
    const trimmed = first.trim();
    this.addAttachment({
      kind: "text",
      label: trimmed.slice(0, 60) + (trimmed.length > 60 ? "…" : ""),
      text,
      source,
    });
  }

  private describeSource(): string {
    const f = this.app.workspace.getActiveFile();
    return f ? f.basename : "note";
  }

  private addAttachment(att: Attachment): void {
    if ("path" in att && this.attachments.some((x) => "path" in x && x.path === att.path)) return;
    this.attachments.push(att);
    this.renderAttachments();
    this.inputEl?.focus();
  }

  private renderAttachments(): void {
    if (!this.attachTray) return;
    this.attachTray.empty();
    const list = this.attachments;
    this.attachTray.toggleClass("is-empty", list.length === 0);
    if (!list.length) return;

    const row = this.attachTray.createDiv({ cls: "claude-card-row" });
    list.forEach((att, i) => {
      buildCard(row, att, this.app, () => {
        this.attachments.splice(i, 1);
        this.renderAttachments();
      });
    });

    const clear = this.attachTray.createEl("button", {
      cls: "claude-attach-clear",
      text: "clear " + list.length,
    });
    clear.addEventListener("click", () => {
      this.attachments = [];
      this.renderAttachments();
    });
  }

  /** The sent message: attachment cards first, then what the user typed. */
  private addUserMessage(text: string, atts: Attachment[]): void {
    const div = this.messagesEl.createDiv({ cls: "claude-msg-user" });
    div.createDiv({ cls: "claude-msg-label" }).setText("You");
    const content = div.createDiv({ cls: "claude-msg-content" });

    if (atts.length) {
      const row = content.createDiv({ cls: "claude-card-row is-sent" });
      atts.forEach((att) => buildCard(row, att, this.app, null));
    }
    if (text) content.createDiv({ cls: "claude-msg-text" }).setText(text);

    const logged = atts
      .map((att) => (att.kind === "text" ? `> ${att.label} (from ${att.source})` : `> ${att.path}`))
      .join("\n");
    this.conversationLog.push(`**You:** ${logged ? logged + "\n\n" : ""}${text}`);
    this.scrollToBottom(true);
  }

  private send(skillId: string | null, text: string): void {
    // First message of a session: say how to refer to places in the vault.
    const body = this.sessionId ? text : CITING_PLACES + text;
    this.isStreaming = true;
    this.hasFirstChunk = false;
    this.updateInputState();

    // Update session bar to show connecting state
    const skillContext = this.activeSkillName ?? "Chat";
    this.skillLabelEl.setText(`${skillContext} · connecting…`);
    this.skillLabelEl.addClass("is-streaming");

    // Create the assistant message container
    const assistantDiv = this.messagesEl.createDiv({ cls: "claude-msg-assistant" });
    assistantDiv.createDiv({ cls: "claude-msg-label" }).setText("Claude");
    this.currentStreamContainer = assistantDiv.createDiv({ cls: "claude-msg-content" });

    // Loading dots — visible until first text chunk arrives
    this.loadingEl = this.currentStreamContainer.createDiv({ cls: "claude-loading-dots" });
    this.loadingEl.createSpan();
    this.loadingEl.createSpan();
    this.loadingEl.createSpan();

    // currentStreamPre is created lazily on the first chunk (see appendChunk)
    this.currentStreamPre = null;

    this.scrollToBottom(true);

    const cancel = runWithSkillStreaming(
      skillId,
      body,
      this.plugin.settings,
      this.sessionId,
      (chunk) => this.appendChunk(chunk),
      (fullText, sid, stats) => void this.finalize(fullText, sid, stats),
      (err) => {
        this.isStreaming = false;
        this.cancelFn = null;
        this.loadingEl?.remove();
        this.loadingEl = null;
        this.skillLabelEl.removeClass("is-streaming");
        this.skillLabelEl.setText(`${skillContext} · error`);
        this.updateInputState();
        this.drainQueue();
        new Notice(`Claude error: ${err.message}`);
        if (this.currentStreamContainer) {
          this.currentStreamContainer.empty();
          this.currentStreamContainer.createSpan({
            cls: "claude-error",
            text: `Error: ${err.message}`,
          });
        }
        this.currentStreamPre = null;
        this.currentStreamContainer = null;
      }
    );

    this.cancelFn = cancel;
  }

  private appendChunk(text: string): void {
    // On the very first chunk: swap loading dots for the streaming <pre>
    if (!this.hasFirstChunk) {
      this.hasFirstChunk = true;
      this.loadingEl?.remove();
      this.loadingEl = null;
      if (this.currentStreamContainer) {
        this.currentStreamPre = this.currentStreamContainer.createEl("pre", {
          cls: "claude-streaming",
        });
      }
      this.skillLabelEl.setText(`${this.activeSkillName ?? "Chat"} · streaming…`);
    }

    if (this.currentStreamPre) {
      this.currentStreamPre.textContent = (this.currentStreamPre.textContent ?? "") + text;
      this.scrollToBottom();
    }
  }

  private async finalize(
    fullText: string,
    sessionId: string | null,
    stats: TurnStats | null = null
  ): Promise<void> {
    this.isStreaming = false;
    this.cancelFn = null;

    // Clean up any leftover loading dots (empty response edge case)
    this.loadingEl?.remove();
    this.loadingEl = null;
    this.skillLabelEl.removeClass("is-streaming");

    if (sessionId) this.sessionId = sessionId;

    const textToRender = fullText || (this.currentStreamPre?.textContent ?? "");
    if (textToRender) {
      this.lastResponseText = textToRender;
      this.conversationLog.push(`**Claude:**\n\n${textToRender}`);
    }
    const container = this.currentStreamContainer;
    this.currentStreamPre = null;
    this.currentStreamContainer = null;

    // Replace <pre> stream with rendered Markdown
    if (container) {
      container.empty();
      const renderedEl = container.createDiv({ cls: "claude-result-rendered" });
      const sourcePath = this.app.workspace.getActiveFile()?.path ?? "";

      await MarkdownRenderer.render(
        this.app,
        textToRender,
        renderedEl,
        sourcePath,
        this
      ).catch(() => {
        renderedEl.empty();
        renderedEl.createEl("pre").setText(textToRender);
      });

      this.openInternalLinksFrom(renderedEl);
      this.addMessageActions(container, renderedEl, textToRender);
      if (stats) this.showTurnCost(container, stats);
    }

    this.skillLabelEl.setText(
      this.sessionId
        ? `${this.activeSkillName ?? "Chat"} · session active`
        : (this.activeSkillName ?? "Chat")
    );

    this.updateInputState();
    this.scrollToBottom();
    this.inputEl?.focus();
    this.drainQueue();
  }

  // ── Close session ──────────────────────────────────────────────────────────

  /**
   * Starts a fresh CLI session while leaving the panel where it is. Changing
   * the mode or the account invalidates the session, but neither is a reason
   * to take the panel away.
   */
  resetSession(): void {
    this.queue = [];
    this.updateQueueHint();
    this.cancelFn?.();
    this.cancelFn = null;
    this.sessionId = null;
    this.isStreaming = false;
    this.lastResponseText = "";
    this.activeSkillName = null;
    this.updateInputState();

    if (this.messagesEl?.childElementCount) {
      this.messagesEl.createEl("hr", { cls: "claude-panel-separator" });
    }
    this.skillLabelEl.setText("Chat");
    this.scrollToBottom(true);
  }

  closeSession(): void {
    this.cancelFn?.();
    this.cancelFn = null;
    this.sessionId = null;
    this.isStreaming = false;
    this.lastResponseText = "";
    this.conversationLog = [];
    this.activeSkillName = null;
    // Close the leaf — removes the panel from the sidebar
    this.leaf.detach();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private addUserBubble(text: string): void {
    const div = this.messagesEl.createDiv({ cls: "claude-msg-user" });
    div.createDiv({ cls: "claude-msg-label" }).setText("You");
    div.createDiv({ cls: "claude-msg-content" }).setText(text);
    this.conversationLog.push(`**You:** ${text}`);
    this.scrollToBottom(true);
  }

  /**
   * Per-message controls. "Copy" takes the whole answer as Markdown; "Source"
   * swaps the rendered answer for its Markdown, so any part of it can be
   * selected and copied with the syntax intact - which rendered HTML loses.
   */
  /** A [[wikilink]] in an answer opens the note, like one in a note would. */
  private openInternalLinksFrom(el: HTMLElement): void {
    el.addEventListener("click", (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest("a.internal-link") as HTMLAnchorElement | null;
      if (!a) return;
      e.preventDefault();
      const href = a.getAttr("data-href") ?? a.getAttribute("href") ?? "";
      if (!href) return;
      const newLeaf = e.metaKey || e.ctrlKey;
      void this.app.workspace.openLinkText(href, "", newLeaf);
    });
  }

  /** What this one answer cost, so the question never has to be guessed at. */
  private showTurnCost(container: HTMLElement, stats: TurnStats): void {
    const n = (v: number) => v.toLocaleString();
    const parts = [
      `${n(stats.inputTokens + stats.cacheReadTokens + stats.cacheWriteTokens)} in`,
      `${n(stats.outputTokens)} out`,
    ];
    if (stats.cacheReadTokens) parts.push(`${n(stats.cacheReadTokens)} cached`);
    if (stats.costUsd !== null) parts.push(`$${stats.costUsd.toFixed(4)}`);

    container.createDiv({ cls: "claude-turn-cost" }).setText(parts.join("  ·  "));
  }

  private addMessageActions(container: HTMLElement, renderedEl: HTMLElement, raw: string): void {
    const bar = container.createDiv({ cls: "claude-msg-actions" });

    const copyBtn = bar.createEl("button", { text: "copy markdown" });
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(raw)
        .then(() => new Notice("Answer copied as Markdown"))
        .catch(() => new Notice("Copy failed — check clipboard permissions"));
    });

    const srcBtn = bar.createEl("button", { text: "source" });
    let pre: HTMLElement | null = null;
    srcBtn.addEventListener("click", () => {
      if (pre) {
        pre.remove();
        pre = null;
        renderedEl.show();
        srcBtn.setText("source");
        return;
      }
      pre = container.createEl("pre", { cls: "claude-msg-source" });
      pre.createEl("code").setText(raw);
      container.insertBefore(pre, bar);
      renderedEl.hide();
      srcBtn.setText("rendered");
    });
  }

  /**
   * @param force  Scroll even if the reader has scrolled up. Only for things
   *               they just did themselves — sending a message, starting a
   *               new session — never for text arriving on its own.
   */
  private scrollToBottom(force = false): void {
    if (!this.messagesEl) return;
    if (!force && !this.stickToBottom) return;
    this.stickToBottom = true;
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private updateInputState(): void {
    if (!this.inputEl || !this.sendBtn) return;
    // The box stays usable while an answer streams: the next message can be
    // written, and sending it queues it behind the one in flight.
    this.inputEl.disabled = false;
    this.sendBtn.disabled = false;
    this.sendBtn.textContent = this.isStreaming ? "\u25A0" : "\u2192";
    this.sendBtn.toggleClass("is-stop", this.isStreaming);
    this.sendBtn.setAttr("aria-label", this.isStreaming ? "Stop" : "Send");
  }

  /** Kills the subprocess and keeps whatever had already streamed. */
  private stopStreaming(): void {
    if (!this.isStreaming) return;
    // Stop means stop: anything queued behind this answer is dropped too.
    this.queue = [];
    this.updateQueueHint();
    this.cancelFn?.();
    this.cancelFn = null;
    this.isStreaming = false;

    const partial = this.currentStreamPre?.textContent ?? "";
    void this.finalize(partial, this.sessionId);
    this.skillLabelEl.setText(`${this.activeSkillName ?? "Chat"} \u00b7 stopped`);
    new Notice("Stopped");
  }

  private updateQueueHint(): void {
    if (!this.queueEl) return;
    const n = this.queue.length;
    this.queueEl.toggleClass("is-empty", n === 0);
    this.queueEl.setText(n === 0 ? "" : n === 1 ? "1 message waiting" : `${n} messages waiting`);
  }

  /** Sends the next queued message, once nothing is streaming. */
  private drainQueue(): void {
    if (this.isStreaming) return;
    const next = this.queue.shift();
    this.updateQueueHint();
    if (next !== undefined) this.send(null, next);
  }

  private async createNote(): Promise<void> {
    if (this.conversationLog.length === 0) return;

    // Build the full conversation transcript
    const noteContent = this.conversationLog.join("\n\n---\n\n");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const skillPart = (this.activeSkillName ?? "Chat").replace(/[/\\:*?"<>|]/g, "-");
    const fileName = `Claude - ${skillPart} - ${timestamp}.md`;

    // Strip any accidental leading/trailing slashes the user may have typed
    const folder = this.plugin.settings.outputFolder.trim().replace(/^\/+|\/+$/g, "");
    const filePath = normalizePath(folder ? `${folder}/${fileName}` : fileName);

    // Ensure the output folder exists. We catch "already exists" errors gracefully
    // because getAbstractFileByPath can miss newly-created folders under some conditions.
    if (folder) {
      const folderPath = normalizePath(folder);
      if (!this.app.vault.getAbstractFileByPath(folderPath)) {
        try {
          await this.app.vault.createFolder(folderPath);
        } catch (err) {
          const msg = (err as Error).message ?? "";
          // "Folder already exists" is not a real error — skip it
          if (!msg.toLowerCase().includes("already exist")) {
            new Notice(`Could not create folder "${folderPath}": ${msg}`);
            return;
          }
        }
      }
    }

    try {
      const file = await this.app.vault.create(filePath, noteContent);
      await this.app.workspace.openLinkText(file.path, "", true);
      new Notice(`Created: ${file.path}`);
    } catch (err) {
      new Notice(`Failed to create note: ${(err as Error).message}`);
    }
  }
}
