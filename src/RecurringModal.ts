import { App, Modal, Notice, Setting } from "obsidian";
import {
  Account,
  CategoryMap,
  CategoryType,
  CATEGORY_TYPES,
  Frequency,
  FREQUENCY_LABELS,
  RecurringRule,
  TYPE_LABELS,
} from "./types";
import { formatCurrency, todayISO } from "./util";
import type FinanceTrackerPlugin from "./main";

export class RecurringModal extends Modal {
  private plugin: FinanceTrackerPlugin;
  private onChanged: () => void;
  private editingId: string | null = null;

  // form state
  private type: CategoryType = "expense";
  private category = "";
  private subcategory = "";
  private amount: number | null = null;
  private frequency: Frequency = "monthly";
  private startDate = todayISO();
  private note = "";
  private account = "";

  private listEl!: HTMLElement;
  private formEl!: HTMLElement;

  constructor(app: App, plugin: FinanceTrackerPlugin, onChanged: () => void) {
    super(app);
    this.plugin = plugin;
    this.onChanged = onChanged;
  }

  private catMap(): CategoryMap {
    return this.plugin.settings.categories[this.type] || {};
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("ft-modal", "ft-recurring-modal");
    contentEl.createEl("h2", { text: "Recurring transactions" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Rules auto-post transactions when they fall due (checked each time Obsidian loads the plugin).",
    });

    this.listEl = contentEl.createDiv("ft-recurring-list");
    this.formEl = contentEl.createDiv("ft-recurring-form");
    this.renderList();
    this.renderForm();
  }

  private renderList() {
    this.listEl.empty();
    const rules = this.plugin.settings.recurring;
    if (rules.length === 0) {
      this.listEl.createDiv({ cls: "ft-empty", text: "No recurring rules yet." });
      return;
    }
    const table = this.listEl.createEl("table", { cls: "ft-table" });
    const hr = table.createEl("thead").createEl("tr");
    ["", "Category", "Amount", "Every", "Next / from", ""].forEach((h) =>
      hr.createEl("th", { text: h })
    );
    const tbody = table.createEl("tbody");
    for (const r of rules) {
      const tr = tbody.createEl("tr");
      if (!r.active) tr.addClass("ft-inactive");

      const toggle = tr.createEl("td").createEl("input");
      toggle.type = "checkbox";
      toggle.checked = r.active;
      toggle.onchange = async () => {
        r.active = toggle.checked;
        await this.plugin.saveSettings();
      };

      tr.createEl("td", {
        text: `${r.category}${r.subcategory ? " › " + r.subcategory : ""}`,
      }).addClass("ft-type-" + r.type);
      tr.createEl("td", { text: formatCurrency(r.amount, this.plugin.settings) }).addClass(
        "ft-amount"
      );
      tr.createEl("td", { text: FREQUENCY_LABELS[r.frequency] });
      tr.createEl("td", { text: r.lastPosted ?? r.startDate });

      const act = tr.createEl("td");
      const edit = act.createEl("button", { text: "✎", cls: "ft-icon-btn" });
      edit.onclick = () => this.loadIntoForm(r);
      const del = act.createEl("button", { text: "🗑", cls: "ft-icon-btn" });
      del.onclick = async () => {
        this.plugin.settings.recurring = this.plugin.settings.recurring.filter(
          (x) => x.id !== r.id
        );
        await this.plugin.saveSettings();
        this.renderList();
      };
    }
  }

  private loadIntoForm(r: RecurringRule) {
    this.editingId = r.id;
    this.type = r.type;
    this.category = r.category;
    this.subcategory = r.subcategory;
    this.amount = r.amount;
    this.frequency = r.frequency;
    this.startDate = r.startDate;
    this.note = r.note;
    this.account = r.account ?? "";
    this.renderForm();
  }

  private resetForm() {
    this.editingId = null;
    this.type = "expense";
    this.category = "";
    this.subcategory = "";
    this.amount = null;
    this.frequency = "monthly";
    this.startDate = todayISO();
    this.note = "";
    this.account = "";
  }

  private renderForm() {
    const el = this.formEl;
    el.empty();
    el.createEl("h3", { text: this.editingId ? "Edit rule" : "Add rule" });

    new Setting(el).setName("Type").addDropdown((dd) => {
      (CATEGORY_TYPES as CategoryType[]).forEach((t) => dd.addOption(t, TYPE_LABELS[t]));
      dd.setValue(this.type);
      dd.onChange((v) => {
        this.type = v as CategoryType;
        const cats = Object.keys(this.catMap());
        this.category = cats[0] ?? "";
        this.subcategory = (this.catMap()[this.category] ?? [])[0] ?? "";
        this.renderForm();
      });
    });

    if (!this.category) {
      const cats = Object.keys(this.catMap());
      this.category = cats[0] ?? "";
      this.subcategory = (this.catMap()[this.category] ?? [])[0] ?? "";
    }

    new Setting(el).setName("Category").addDropdown((dd) => {
      Object.keys(this.catMap()).forEach((c) => dd.addOption(c, c));
      dd.setValue(this.category);
      dd.onChange((v) => {
        this.category = v;
        this.subcategory = (this.catMap()[v] ?? [])[0] ?? "";
        this.renderForm();
      });
    });

    new Setting(el).setName("Sub-category").addDropdown((dd) => {
      dd.addOption("", "—");
      (this.catMap()[this.category] ?? []).forEach((s) => dd.addOption(s, s));
      dd.setValue(this.subcategory);
      dd.onChange((v) => (this.subcategory = v));
    });

    const accts = this.plugin.settings.accounts.filter((a) => a.active || a.id === this.account);
    new Setting(el).setName("Account").addDropdown((dd) => {
      dd.addOption("", "(none)");
      accts.forEach((a) => dd.addOption(a.id, a.name));
      dd.setValue(this.account);
      dd.onChange((v) => (this.account = v));
    });

    new Setting(el).setName("Amount").addText((t) => {
      t.inputEl.type = "number";
      t.inputEl.setAttr("min", "0");
      t.inputEl.setAttr("step", "0.01");
      if (this.amount != null) t.setValue(String(this.amount));
      t.onChange((v) => (this.amount = v === "" ? null : parseFloat(v)));
    });

    new Setting(el).setName("Frequency").addDropdown((dd) => {
      (Object.keys(FREQUENCY_LABELS) as Frequency[]).forEach((f) =>
        dd.addOption(f, FREQUENCY_LABELS[f])
      );
      dd.setValue(this.frequency);
      dd.onChange((v) => (this.frequency = v as Frequency));
    });

    new Setting(el)
      .setName("Start date")
      .setDesc("First occurrence. Past dates will back-fill up to today.")
      .addText((t) => {
        t.inputEl.type = "date";
        t.setValue(this.startDate);
        t.onChange((v) => (this.startDate = v));
      });

    new Setting(el).setName("Note").addText((t) => {
      t.setValue(this.note);
      t.setPlaceholder("Optional");
      t.onChange((v) => (this.note = v));
    });

    const actions = el.createDiv("ft-modal-actions");
    const save = actions.createEl("button", {
      text: this.editingId ? "Save rule" : "Add rule",
      cls: "mod-cta",
    });
    save.onclick = () => this.saveRule();
    if (this.editingId) {
      const cancel = actions.createEl("button", { text: "New" });
      cancel.onclick = () => {
        this.resetForm();
        this.renderForm();
      };
    }
  }

  private async saveRule() {
    if (this.amount == null || isNaN(this.amount) || this.amount <= 0) {
      new Notice("Please enter a valid amount.");
      return;
    }
    if (!this.category) {
      new Notice("Please choose a category.");
      return;
    }
    if (this.editingId) {
      const r = this.plugin.settings.recurring.find((x) => x.id === this.editingId);
      if (r) {
        r.type = this.type;
        r.category = this.category;
        r.subcategory = this.subcategory;
        r.amount = Math.abs(this.amount);
        r.frequency = this.frequency;
        r.startDate = this.startDate;
        r.note = this.note.trim();
        r.account = this.account || undefined;
      }
    } else {
      const rule: RecurringRule = {
        id: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
        type: this.type,
        category: this.category,
        subcategory: this.subcategory,
        amount: Math.abs(this.amount),
        note: this.note.trim(),
        account: this.account || undefined,
        frequency: this.frequency,
        startDate: this.startDate,
        lastPosted: null,
        active: true,
      };
      this.plugin.settings.recurring.push(rule);
    }
    await this.plugin.saveSettings();
    // immediately post anything already due
    await this.plugin.materializeRecurring();
    this.resetForm();
    this.renderList();
    this.renderForm();
    this.onChanged();
    new Notice("Recurring rule saved.");
  }

  onClose() {
    this.contentEl.empty();
  }
}
