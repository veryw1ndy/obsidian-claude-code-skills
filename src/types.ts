export interface Skill {
  id: string;          // directory name: "yara-and-sigma"
  name: string;        // YAML frontmatter: name field
  description: string; // YAML frontmatter: description field
}

export interface PluginSettings {
  claudeBinPath: string;    // path to claude CLI binary
  workingDirectory: string; // cwd for subprocess (must contain CLAUDE.md)
  accounts: string;         // one "name = /path/to/config-dir" per line
  activeAccount: string;    // the name currently in use; empty = the CLI default
  focusedMode: boolean;     // answer only from what was dragged in, with no tools
  timeout: number;          // ms before killing subprocess
  maxBudgetUsd: number;     // per-query API spend cap in USD (0 = no cap)
  outputFolder: string;     // vault-relative folder for created notes (empty = vault root)
  enabledSkills: string[];  // skill IDs that appear in the context menu (empty = all enabled)
}

export const DEFAULT_SETTINGS: PluginSettings = {
  claudeBinPath: "",        // auto-detected on first load; enter manually if needed
  workingDirectory: "",     // must be configured — directory containing CLAUDE.md
  accounts: "",             // e.g. "main = ~/.claude\nsecond = ~/.claude-second"
  activeAccount: "",
  focusedMode: false,
  timeout: 120000,
  maxBudgetUsd: 0.25,
  outputFolder: "",         // empty = vault root
  enabledSkills: [],        // empty = all skills enabled
};
