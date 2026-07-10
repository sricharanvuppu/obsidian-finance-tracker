import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import { CategoryMap, CategoryType, CATEGORY_TYPES, TYPE_LABELS, DEFAULT_CATEGORIES } from "./types";
import { AccountModal } from "./AccountModal";
import { WantsModal } from "./WantsModal";
import type FinanceTrackerPlugin from "./main";

export class FinanceSettingTab extends PluginSettingTab {
  private plugin: FinanceTrackerPlugin;

  constructor(app: App, plugin: FinanceTrackerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Finance Tracker" });

    new Setting(containerEl)
      .setName("Data file path")
      .setDesc("JSON file (relative to vault root) where transactions are stored.")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.dataFilePath)
          .setPlaceholder("_finance/finance-data.json")
          .onChange(async (v) => {
            this.plugin.settings.dataFilePath = v.trim() || "_finance/finance-data.json";
            await this.plugin.saveSettings();
            this.plugin.store.setPath(this.plugin.settings.dataFilePath);
            await this.plugin.store.load();
          })
      );

    new Setting(containerEl)
      .setName("Currency")
      .setDesc("ISO currency code, e.g. INR, USD, EUR.")
      .addText((t) =>
        t.setValue(this.plugin.settings.currency).onChange(async (v) => {
          this.plugin.settings.currency = v.trim().toUpperCase() || "INR";
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Locale")
      .setDesc("Number/currency formatting locale, e.g. en-IN, en-US.")
      .addText((t) =>
        t.setValue(this.plugin.settings.locale).onChange(async (v) => {
          this.plugin.settings.locale = v.trim() || "en-IN";
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Base currency")
      .setDesc("Currency all totals/net worth are shown in. Per-account currencies convert to this.")
      .addText((t) =>
        t.setValue(this.plugin.settings.baseCurrency || this.plugin.settings.currency || "INR").onChange(async (v) => {
          this.plugin.settings.baseCurrency = v.trim().toUpperCase() || "INR";
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Exchange rates")
      .setDesc("One per line as \"CODE: value-in-base\" (e.g. USD: 83). Used to convert foreign-currency accounts to the base currency.")
      .addTextArea((ta) => {
        ta.inputEl.rows = 3;
        ta.inputEl.addClass("ft-cat-textarea");
        const rates = this.plugin.settings.rates || {};
        ta.setValue(Object.keys(rates).map((k) => `${k}: ${rates[k]}`).join("\n"));
        ta.onChange(async (v) => {
          const map: Record<string, number> = {};
          v.split("\n").forEach((line) => {
            const m = /^\s*([A-Za-z]{2,5})\s*[:=]\s*([0-9.]+)\s*$/.exec(line);
            if (m) map[m[1].toUpperCase()] = parseFloat(m[2]);
          });
          this.plugin.settings.rates = map;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Accounts")
      .setDesc("Manage accounts (cash, bank, wallets) and their initial balances.")
      .addButton((b) =>
        b.setButtonText("Manage accounts").onClick(() => {
          new AccountModal(this.app, this.plugin, () => {}).open();
        })
      );

    new Setting(containerEl)
      .setName("Monthly savings goal")
      .setDesc("Target amount to save each month (income − expense). 0 to disable.")
      .addText((t) => {
        t.inputEl.type = "number";
        t.inputEl.setAttr("min", "0");
        t.setValue(String(this.plugin.settings.savingsGoal || 0));
        t.onChange(async (v) => {
          const n = parseFloat(v);
          this.plugin.settings.savingsGoal = isNaN(n) || n < 0 ? 0 : n;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Needs vs Wants")
      .setDesc("Mark discretionary spending as 'Wants' — at category or sub-category level (e.g. Groceries → only Snacks).")
      .addButton((b) =>
        b.setButtonText("Classify categories").onClick(() => {
          new WantsModal(this.app, this.plugin, () => {}).open();
        })
      );

    containerEl.createEl("h3", { text: "Categories" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Configure categories and their sub-categories for each type. Use one line per category as \"Category: sub1, sub2, sub3\".",
    });

    (CATEGORY_TYPES as CategoryType[]).forEach((type) => {
      this.renderCategoryEditor(containerEl, type);
    });

    new Setting(containerEl)
      .setName("Reset categories to defaults")
      .addButton((b) =>
        b
          .setButtonText("Reset")
          .setWarning()
          .onClick(async () => {
            this.plugin.settings.categories = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
            await this.plugin.saveSettings();
            new Notice("Categories reset to defaults.");
            this.display();
          })
      );

    this.renderBudgets(containerEl);
  }

  private renderBudgets(containerEl: HTMLElement) {
    containerEl.createEl("h3", { text: "Monthly budgets" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Set a monthly budget per expense category. Leave blank or 0 for no budget. Used by the Budget view.",
    });

    const expenseCats = Object.keys(this.plugin.settings.categories.expense || {});
    for (const cat of expenseCats) {
      new Setting(containerEl).setName(cat).addText((t) => {
        t.inputEl.type = "number";
        t.inputEl.setAttr("min", "0");
        t.inputEl.setAttr("step", "0.01");
        const cur = this.plugin.settings.budgets[cat];
        if (cur != null) t.setValue(String(cur));
        t.setPlaceholder("0");
        t.onChange(async (v) => {
          const n = parseFloat(v);
          if (v === "" || isNaN(n) || n <= 0) {
            delete this.plugin.settings.budgets[cat];
          } else {
            this.plugin.settings.budgets[cat] = n;
          }
          await this.plugin.saveSettings();
        });
      });
    }
  }

  private mapToText(map: CategoryMap): string {
    return Object.keys(map)
      .map((cat) => `${cat}: ${(map[cat] || []).join(", ")}`)
      .join("\n");
  }

  private textToMap(text: string): CategoryMap {
    const map: CategoryMap = {};
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .forEach((line) => {
        const idx = line.indexOf(":");
        let cat: string;
        let subs: string[] = [];
        if (idx >= 0) {
          cat = line.slice(0, idx).trim();
          subs = line
            .slice(idx + 1)
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        } else {
          cat = line;
        }
        if (cat) map[cat] = subs;
      });
    return map;
  }

  private renderCategoryEditor(containerEl: HTMLElement, type: CategoryType) {
    const setting = new Setting(containerEl)
      .setName(TYPE_LABELS[type])
      .setDesc(`One category per line — "Category: sub1, sub2"`);
    setting.settingEl.addClass("ft-cat-setting");
    setting.addTextArea((ta) => {
      ta.inputEl.rows = 8;
      ta.inputEl.addClass("ft-cat-textarea");
      ta.setValue(this.mapToText(this.plugin.settings.categories[type]));
      ta.onChange(async (v) => {
        this.plugin.settings.categories[type] = this.textToMap(v);
        await this.plugin.saveSettings();
      });
    });
  }
}
