import { App, Modal, Notice } from "obsidian";
import type ClaudeCodeSkillsPlugin from "./main";
import { accountDir, accountNames } from "./executor";
import { readAuthStatus, startLogin, type LoginHandle } from "./auth";

/**
 * Logs an account in without a terminal. Typing `/login` into the panel, or
 * running the CLI under the right CLAUDE_CONFIG_DIR by hand, were the only
 * ways before, and neither is something to have to remember mid-revision.
 */
export class LoginModal extends Modal {
  private handle: LoginHandle | null = null;
  private loggedIn = false;

  constructor(
    app: App,
    private plugin: ClaudeCodeSkillsPlugin,
    private account: string,
    private onLoggedIn?: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.account ? `Log in to Claude: ${this.account}` : "Log in to Claude");
    this.modalEl.addClass("claude-login-modal");
    this.begin();
  }

  onClose(): void {
    this.handle?.cancel();
    this.handle = null;
    this.contentEl.empty();
    this.plugin.refreshAccountChip();
    // Closing by any route counts: Done, Escape, or the cross.
    if (this.loggedIn) this.onLoggedIn?.();
  }

  private dir(): string {
    return accountDir(this.plugin.settings, this.account);
  }

  private begin(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.loggedIn = false;
    const who = this.account ? `"${this.account}"` : "this panel";

    const status = contentEl.createDiv({ cls: "claude-login-status" });
    status.setText("Opening the sign-in page in your browser…");

    const steps = contentEl.createEl("ol", { cls: "claude-login-steps" });
    steps.createEl("li", {
      text: `In the browser, check the page shows the Claude account you want for ${who}, then click Authorize.`,
    });
    steps.createEl("li", { text: "Come back here. This window updates by itself." });

    // The browser signs in as whoever it is already signed in as, which is
    // usually the other account. A private window has no one signed in, and
    // the link below finishes with a code to paste rather than a callback.
    const other = contentEl.createDiv({ cls: "claude-login-other" });
    other.createDiv({
      cls: "claude-login-hint",
      text:
        "Page shows the wrong account, or no page opened? Copy the link, open it " +
        "in a private window, sign in there, and paste the code it gives you here.",
    });

    const linkRow = other.createDiv({ cls: "claude-login-row" });
    const copyBtn = linkRow.createEl("button", { text: "Copy sign-in link" });
    const openBtn = linkRow.createEl("button", { text: "Open it here instead" });
    copyBtn.disabled = true;
    openBtn.disabled = true;

    const codeRow = other.createDiv({ cls: "claude-login-row" });
    const codeInput = codeRow.createEl("input", {
      type: "text",
      cls: "claude-login-code",
      attr: { placeholder: "Paste the code here", spellcheck: "false" },
    });
    const codeBtn = codeRow.createEl("button", { text: "Submit code" });

    const submit = () => {
      const code = codeInput.value.trim();
      if (!code) return;
      this.handle?.sendCode(code);
      codeInput.value = "";
      status.setText("Checking the code…");
    };
    codeBtn.addEventListener("click", submit);
    codeInput.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });

    let url = "";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(url)
        .then(() => new Notice("Sign-in link copied"))
        .catch(() => new Notice("Copy failed — check clipboard permissions"));
    });
    openBtn.addEventListener("click", () => {
      window.open(url);
    });

    const footer = contentEl.createDiv({ cls: "claude-login-row is-footer" });
    footer.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());

    this.handle = startLogin(this.plugin.settings, this.dir(), {
      url: (u) => {
        url = u;
        copyBtn.disabled = false;
        openBtn.disabled = false;
        status.setText("Waiting for you to sign in in the browser…");
      },
      done: () => {
        this.handle = null;
        void this.showDone();
      },
      failed: (message) => {
        this.handle = null;
        this.showFailed(message);
      },
    });
  }

  private async showDone(): Promise<void> {
    const { contentEl } = this;
    this.loggedIn = true;
    contentEl.empty();

    const status = contentEl.createDiv({ cls: "claude-login-status is-ok", text: "Logged in." });
    const settings = this.plugin.settings;

    try {
      const me = await readAuthStatus(settings, this.dir());
      if (me.email) status.setText(`Logged in as ${me.email}.`);

      // Two accounts that are really one share a single usage limit, which
      // defeats the point of having two - and it is the easy mistake to make.
      // The limit belongs to the organisation, not the email: one email can be
      // in two organisations, each with its own plan.
      for (const name of accountNames(settings)) {
        if (name === this.account || !me.orgId) continue;
        const them = await readAuthStatus(settings, accountDir(settings, name)).catch(() => null);
        if (them?.loggedIn && them.orgId === me.orgId) {
          contentEl.createDiv({
            cls: "claude-login-warning",
            text:
              `That is the same Claude account and plan as "${name}", so the two share one ` +
              "usage limit. To use a different account, click Log in again and sign " +
              "in through the link in a private window.",
          });
          break;
        }
      }
    } catch {
      // The login went through; the name is only a courtesy.
    }

    const row = contentEl.createDiv({ cls: "claude-login-row is-footer" });
    row.createEl("button", { text: "Log in again" }).addEventListener("click", () => this.begin());
    row.createEl("button", { text: "Done", cls: "mod-cta" }).addEventListener("click", () => this.close());
  }

  private showFailed(message: string): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createDiv({ cls: "claude-login-status is-error", text: `Login did not finish: ${message}` });
    const row = contentEl.createDiv({ cls: "claude-login-row is-footer" });
    row.createEl("button", { text: "Close" }).addEventListener("click", () => this.close());
    row.createEl("button", { text: "Try again", cls: "mod-cta" }).addEventListener("click", () => this.begin());
  }
}
