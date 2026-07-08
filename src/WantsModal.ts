import { App, Modal, Setting } from "obsidian";
import type FinanceTrackerPlugin from "./main";

/**
 * Classify expense categories/sub-categories as Needs (default) or Wants.
 * Stored in settings.discretionary as keys: "Category" (whole) or
 * "Category|Sub-category" (specific sub).
 */
export class WantsModal extends Modal {
  private plugin: FinanceTrackerPlugin;
  private onChanged: () => void;

  constructor(app: App, plugin: FinanceTrackerPlugin, onChanged: () => void) {
    super(app);
    this.plugin = plugin;
    this.onChanged = onChanged;
  }

  private set(): Set<string> {
    return new Set(this.plugin.settings.discretionary || []);
  }

  private async persist(s: Set<string>) {
    this.plugin.settings.discretionary = Array.from(s);
    await this.plugin.saveSettings();
    this.onChanged();
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("ft-modal", "ft-wants-modal");
    contentEl.createEl("h2", { text: "Needs vs Wants" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Mark discretionary spending as 'Wants'. You can flag a whole category, or specific sub-categories (e.g. Groceries → only 'Snacks'). Anything not marked counts as a Need.",
    });

    const expense = this.plugin.settings.categories.expense || {};
    const cats = Object.keys(expense).sort();
    if (cats.length === 0) {
      contentEl.createDiv({ cls: "ft-empty", text: "No expense categories defined." });
      return;
    }

    for (const cat of cats) {
      const wholeKey = cat;
      const catSetting = new Setting(contentEl)
        .setName(cat)
        .setDesc("Whole category is a Want")
        .addToggle((tg) => {
          tg.setValue(this.set().has(wholeKey));
          tg.onChange(async (v) => {
            const s = this.set();
            if (v) s.add(wholeKey);
            else s.delete(wholeKey);
            await this.persist(s);
            this.display(); // re-render to reflect enabled/disabled subs
          });
        });
      catSetting.nameEl.style.fontWeight = "700";

      const wholeOn = this.set().has(wholeKey);
      const subs = expense[cat] || [];
      for (const sub of subs) {
        const key = `${cat}|${sub}`;
        new Setting(contentEl)
          .setName("↳ " + sub)
          .addToggle((tg) => {
            tg.setValue(wholeOn || this.set().has(key));
            tg.setDisabled(wholeOn);
            tg.onChange(async (v) => {
              const s = this.set();
              if (v) s.add(key);
              else s.delete(key);
              await this.persist(s);
            });
          });
      }
    }
  }

  /** Re-render (used when a whole-category toggle changes). */
  private display() {
    this.contentEl.empty();
    this.onOpen();
  }

  onClose() {
    this.contentEl.empty();
  }
}
