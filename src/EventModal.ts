import { App, Modal, Notice, Setting } from "obsidian";
import { LifeEvent, EventStatus, EVENT_STATUS_LABELS } from "./types";
import { formatCurrency, todayISO } from "./util";
import type FinanceTrackerPlugin from "./main";

export class EventModal extends Modal {
  private plugin: FinanceTrackerPlugin;
  private onChanged: () => void;

  private editingId: string | null = null;
  private name = "";
  private target: number | null = null;
  private startDate = todayISO();
  private endDate = "";
  private status: EventStatus = "active";
  private capital = true;
  private note = "";

  private listEl!: HTMLElement;
  private formEl!: HTMLElement;

  constructor(app: App, plugin: FinanceTrackerPlugin, onChanged: () => void) {
    super(app);
    this.plugin = plugin;
    this.onChanged = onChanged;
  }

  private spent(eventId: string): number {
    return this.plugin.store
      .getAll()
      .filter((t) => t.event === eventId && (t.type === "expense" || t.type === "investment"))
      .reduce((s, t) => s + t.amount, 0);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("ft-modal", "ft-event-modal");
    contentEl.createEl("h2", { text: "Life events" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Track big one-off events (wedding, home, baby). Capital events are excluded from your monthly/overspending analysis but still count in balances and net worth.",
    });
    this.listEl = contentEl.createDiv("ft-event-list");
    this.formEl = contentEl.createDiv("ft-event-form");
    this.renderList();
    this.renderForm();
  }

  private renderList() {
    this.listEl.empty();
    const events = this.plugin.settings.events;
    if (events.length === 0) {
      this.listEl.createDiv({ cls: "ft-empty", text: "No events yet." });
      return;
    }
    const table = this.listEl.createEl("table", { cls: "ft-table" });
    const hr = table.createEl("thead").createEl("tr");
    ["Event", "Status", "Spent", "Target", "Capital", ""].forEach((h) => {
      const th = hr.createEl("th", { text: h });
      if (["Spent", "Target"].includes(h)) th.addClass("ft-col-amount");
    });
    const tbody = table.createEl("tbody");
    for (const e of events) {
      const tr = tbody.createEl("tr");
      tr.createEl("td", { text: e.name });
      tr.createEl("td", { text: EVENT_STATUS_LABELS[e.status] });
      tr.createEl("td", { text: formatCurrency(this.spent(e.id), this.plugin.settings) }).addClass("ft-amount");
      tr.createEl("td", { text: e.target ? formatCurrency(e.target, this.plugin.settings) : "—" }).addClass("ft-amount");
      tr.createEl("td", { text: e.capital ? "Yes" : "No" });
      const act = tr.createEl("td");
      const edit = act.createEl("button", { text: "✎", cls: "ft-icon-btn" });
      edit.onclick = () => this.loadIntoForm(e);
      const del = act.createEl("button", { text: "🗑", cls: "ft-icon-btn" });
      del.onclick = async () => {
        const used = this.plugin.store.getAll().some((t) => t.event === e.id);
        if (used) {
          new Notice("This event has transactions. Reassign or delete them first, or keep the event.");
          return;
        }
        this.plugin.settings.events = this.plugin.settings.events.filter((x) => x.id !== e.id);
        await this.plugin.saveSettings();
        this.renderList();
        this.onChanged();
      };
    }
  }

  private loadIntoForm(e: LifeEvent) {
    this.editingId = e.id;
    this.name = e.name;
    this.target = e.target ?? null;
    this.startDate = e.startDate ?? todayISO();
    this.endDate = e.endDate ?? "";
    this.status = e.status;
    this.capital = e.capital;
    this.note = e.note ?? "";
    this.renderForm();
  }

  private resetForm() {
    this.editingId = null;
    this.name = "";
    this.target = null;
    this.startDate = todayISO();
    this.endDate = "";
    this.status = "active";
    this.capital = true;
    this.note = "";
  }

  private renderForm() {
    const el = this.formEl;
    el.empty();
    el.createEl("h3", { text: this.editingId ? "Edit event" : "Add event" });

    new Setting(el).setName("Name").addText((t) => {
      t.setValue(this.name);
      t.setPlaceholder("e.g. Wedding 2026, New Home");
      t.onChange((v) => (this.name = v));
    });

    new Setting(el).setName("Target / budget (optional)").addText((t) => {
      t.inputEl.type = "number";
      t.inputEl.setAttr("min", "0");
      t.inputEl.setAttr("step", "0.01");
      if (this.target != null) t.setValue(String(this.target));
      t.onChange((v) => (this.target = v === "" ? null : parseFloat(v)));
    });

    new Setting(el).setName("Status").addDropdown((dd) => {
      (Object.keys(EVENT_STATUS_LABELS) as EventStatus[]).forEach((s) => dd.addOption(s, EVENT_STATUS_LABELS[s]));
      dd.setValue(this.status);
      dd.onChange((v) => (this.status = v as EventStatus));
    });

    new Setting(el)
      .setName("Capital event")
      .setDesc("Exclude this event's spending from monthly & overspending analysis.")
      .addToggle((tg) => {
        tg.setValue(this.capital);
        tg.onChange((v) => (this.capital = v));
      });

    new Setting(el).setName("Start date").addText((t) => {
      t.inputEl.type = "date";
      t.setValue(this.startDate);
      t.onChange((v) => (this.startDate = v));
    });

    new Setting(el).setName("End date (optional)").addText((t) => {
      t.inputEl.type = "date";
      t.setValue(this.endDate);
      t.onChange((v) => (this.endDate = v));
    });

    new Setting(el).setName("Note").addText((t) => {
      t.setValue(this.note);
      t.setPlaceholder("Optional");
      t.onChange((v) => (this.note = v));
    });

    const actions = el.createDiv("ft-modal-actions");
    const save = actions.createEl("button", { text: this.editingId ? "Save event" : "Add event", cls: "mod-cta" });
    save.onclick = () => this.save();
    if (this.editingId) {
      const nw = actions.createEl("button", { text: "New" });
      nw.onclick = () => { this.resetForm(); this.renderForm(); };
    }
  }

  private async save() {
    if (!this.name.trim()) {
      new Notice("Please enter an event name.");
      return;
    }
    const payload = {
      name: this.name.trim(),
      target: this.target ?? undefined,
      startDate: this.startDate || undefined,
      endDate: this.endDate || undefined,
      status: this.status,
      capital: this.capital,
      note: this.note.trim() || undefined,
    };
    if (this.editingId) {
      const e = this.plugin.settings.events.find((x) => x.id === this.editingId);
      if (e) Object.assign(e, payload);
    } else {
      this.plugin.settings.events.push({
        id: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
        ...payload,
      });
    }
    await this.plugin.saveSettings();
    this.resetForm();
    this.renderList();
    this.renderForm();
    this.onChanged();
    new Notice("Event saved.");
  }

  onClose() {
    this.contentEl.empty();
  }
}
