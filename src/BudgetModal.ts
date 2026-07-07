import { App, Modal, Setting, Notice } from "obsidian";
import type FinanceTrackerPlugin from "./main";

export class BudgetModal extends Modal {
  private plugin: FinanceTrackerPlugin;
  private onSaved: () => void;
  private draft: Record<string, string> = {};

  constructor(app: App, plugin: FinanceTrackerPlugin, onSaved: () => void) {
    super(app);
    this.plugin = plugin;
    this.onSaved = onSaved;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("ft-modal");
    contentEl.createEl("h2", { text: "Monthly budgets" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Set a monthly budget per expense category. Leave blank for no budget.",
    });

    const cats = Object.keys(this.plugin.settings.categories.expense || {}).sort();
    if (cats.length === 0) {
      contentEl.createDiv({
        cls: "ft-empty",
        text: "No expense categories defined. Add some in plugin settings first.",
      });
      return;
    }

    // seed draft with current values
    for (const cat of cats) {
      const cur = this.plugin.settings.budgets[cat];
      this.draft[cat] = cur != null ? String(cur) : "";
    }

    for (const cat of cats) {
      new Setting(contentEl).setName(cat).addText((t) => {
        t.inputEl.type = "number";
        t.inputEl.setAttr("min", "0");
        t.inputEl.setAttr("step", "0.01");
        t.setPlaceholder("0");
        t.setValue(this.draft[cat]);
        t.onChange((v) => (this.draft[cat] = v));
      });
    }

    const actions = contentEl.createDiv("ft-modal-actions");
    const save = actions.createEl("button", { text: "Save", cls: "mod-cta" });
    save.onclick = async () => {
      for (const cat of cats) {
        const raw = (this.draft[cat] ?? "").trim();
        const n = parseFloat(raw);
        if (raw === "" || isNaN(n) || n <= 0) {
          delete this.plugin.settings.budgets[cat];
        } else {
          this.plugin.settings.budgets[cat] = n;
        }
      }
      await this.plugin.saveSettings();
      new Notice("Budgets saved.");
      this.onSaved();
      this.close();
    };
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}
