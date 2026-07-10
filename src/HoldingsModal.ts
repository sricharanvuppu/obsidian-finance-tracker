import { App, Modal, Notice, Setting } from "obsidian";
import { Holding } from "./types";
import { formatCurrency } from "./util";
import type FinanceTrackerPlugin from "./main";

export class HoldingsModal extends Modal {
  private plugin: FinanceTrackerPlugin;
  private onChanged: () => void;

  private editingId: string | null = null;
  private name = "";
  private kind = "Stock";
  private units: number | null = null;
  private price: number | null = null;
  private note = "";

  private listEl!: HTMLElement;
  private formEl!: HTMLElement;

  constructor(app: App, plugin: FinanceTrackerPlugin, onChanged: () => void) {
    super(app);
    this.plugin = plugin;
    this.onChanged = onChanged;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("ft-modal", "ft-holdings-modal");
    contentEl.createEl("h2", { text: "Investment holdings" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Track units and current price of your investments. Their market value is added to your net worth. Update the price periodically to keep net worth accurate.",
    });
    this.listEl = contentEl.createDiv("ft-holdings-list");
    this.formEl = contentEl.createDiv("ft-holdings-form");
    this.renderList();
    this.renderForm();
  }

  private renderList() {
    this.listEl.empty();
    const holdings = this.plugin.settings.holdings;
    if (holdings.length === 0) {
      this.listEl.createDiv({ cls: "ft-empty", text: "No holdings yet." });
      return;
    }
    let total = 0;
    const table = this.listEl.createEl("table", { cls: "ft-table" });
    const hr = table.createEl("thead").createEl("tr");
    ["Holding", "Kind", "Units", "Price", "Value", ""].forEach((h) => {
      const th = hr.createEl("th", { text: h });
      if (["Units", "Price", "Value"].includes(h)) th.addClass("ft-col-amount");
    });
    const tbody = table.createEl("tbody");
    for (const h of holdings) {
      const value = (h.units || 0) * (h.price || 0);
      total += value;
      const tr = tbody.createEl("tr");
      tr.createEl("td", { text: h.name });
      tr.createEl("td", { text: h.kind });
      tr.createEl("td", { text: String(h.units) }).addClass("ft-amount");
      tr.createEl("td", { text: formatCurrency(h.price, this.plugin.settings) }).addClass("ft-amount");
      tr.createEl("td", { text: formatCurrency(value, this.plugin.settings) }).addClass("ft-amount");
      const act = tr.createEl("td");
      const edit = act.createEl("button", { text: "✎", cls: "ft-icon-btn" });
      edit.onclick = () => this.loadIntoForm(h);
      const del = act.createEl("button", { text: "🗑", cls: "ft-icon-btn" });
      del.onclick = async () => {
        this.plugin.settings.holdings = this.plugin.settings.holdings.filter((x) => x.id !== h.id);
        await this.plugin.saveSettings();
        this.renderList();
        this.onChanged();
      };
    }
    this.listEl.createDiv({ cls: "ft-holdings-total", text: "Total value: " + formatCurrency(total, this.plugin.settings) });
  }

  private loadIntoForm(h: Holding) {
    this.editingId = h.id;
    this.name = h.name;
    this.kind = h.kind;
    this.units = h.units;
    this.price = h.price;
    this.note = h.note ?? "";
    this.renderForm();
  }

  private resetForm() {
    this.editingId = null;
    this.name = "";
    this.kind = "Stock";
    this.units = null;
    this.price = null;
    this.note = "";
  }

  private renderForm() {
    const el = this.formEl;
    el.empty();
    el.createEl("h3", { text: this.editingId ? "Edit holding" : "Add holding" });

    new Setting(el).setName("Name").addText((t) => {
      t.setValue(this.name);
      t.setPlaceholder("e.g. Nifty 50 Index, INFY, Gold");
      t.onChange((v) => (this.name = v));
    });
    new Setting(el).setName("Kind").addText((t) => {
      t.setValue(this.kind);
      t.setPlaceholder("Stock / Mutual Fund / Gold …");
      t.onChange((v) => (this.kind = v));
    });
    new Setting(el).setName("Units").addText((t) => {
      t.inputEl.type = "number";
      t.inputEl.setAttr("step", "any");
      if (this.units != null) t.setValue(String(this.units));
      t.onChange((v) => (this.units = v === "" ? null : parseFloat(v)));
    });
    new Setting(el).setName("Current price / unit").addText((t) => {
      t.inputEl.type = "number";
      t.inputEl.setAttr("step", "any");
      if (this.price != null) t.setValue(String(this.price));
      t.onChange((v) => (this.price = v === "" ? null : parseFloat(v)));
    });
    new Setting(el).setName("Note").addText((t) => {
      t.setValue(this.note);
      t.setPlaceholder("Optional");
      t.onChange((v) => (this.note = v));
    });

    const actions = el.createDiv("ft-modal-actions");
    const save = actions.createEl("button", { text: this.editingId ? "Save" : "Add holding", cls: "mod-cta" });
    save.onclick = () => this.save();
    if (this.editingId) {
      const nw = actions.createEl("button", { text: "New" });
      nw.onclick = () => { this.resetForm(); this.renderForm(); };
    }
  }

  private async save() {
    if (!this.name.trim()) { new Notice("Enter a holding name."); return; }
    const units = this.units ?? 0;
    const price = this.price ?? 0;
    if (this.editingId) {
      const h = this.plugin.settings.holdings.find((x) => x.id === this.editingId);
      if (h) { h.name = this.name.trim(); h.kind = this.kind.trim() || "Other"; h.units = units; h.price = price; h.note = this.note.trim() || undefined; }
    } else {
      this.plugin.settings.holdings.push({
        id: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
        name: this.name.trim(),
        kind: this.kind.trim() || "Other",
        units,
        price,
        note: this.note.trim() || undefined,
      });
    }
    await this.plugin.saveSettings();
    this.resetForm();
    this.renderList();
    this.renderForm();
    this.onChanged();
    new Notice("Holding saved.");
  }

  onClose() {
    this.contentEl.empty();
  }
}
