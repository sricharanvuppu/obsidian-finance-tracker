import { App, Modal, Notice, Setting, normalizePath } from "obsidian";
import { parseTransactionsCSV, ParsedRow } from "./util";
import { Transaction } from "./types";
import type FinanceTrackerPlugin from "./main";

export class ImportModal extends Modal {
  private plugin: FinanceTrackerPlugin;
  private onDone: () => void;
  private csvText = "";
  private createMissingAccounts = true;

  constructor(app: App, plugin: FinanceTrackerPlugin, onDone: () => void) {
    super(app);
    this.plugin = plugin;
    this.onDone = onDone;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("ft-modal");
    contentEl.createEl("h2", { text: "Import transactions (CSV)" });
    contentEl.createEl("p", {
      cls: "setting-item-description",
      text: "Paste CSV with a header row. Recognised columns: date (YYYY-MM-DD), time, type, category, sub-category, amount, account, to-account, note. Or enter a vault path to a .csv file below.",
    });

    const ta = contentEl.createEl("textarea");
    ta.rows = 8;
    ta.style.width = "100%";
    ta.placeholder = "date,type,category,sub-category,amount,account,note\n2026-07-01,expense,Groceries,Vegetables,500,HDFC Savings,";
    ta.addClass("ft-cat-textarea");
    ta.oninput = () => (this.csvText = ta.value);

    let pathVal = "";
    new Setting(contentEl)
      .setName("…or vault path to CSV")
      .addText((t) => {
        t.setPlaceholder("_finance/import.csv");
        t.onChange((v) => (pathVal = v.trim()));
      })
      .addButton((b) =>
        b.setButtonText("Load").onClick(async () => {
          if (!pathVal) return;
          try {
            const p = normalizePath(pathVal);
            if (!(await this.app.vault.adapter.exists(p))) {
              new Notice("File not found: " + p);
              return;
            }
            this.csvText = await this.app.vault.adapter.read(p);
            ta.value = this.csvText;
            new Notice("Loaded CSV. Review and import.");
          } catch (e) {
            new Notice("Could not read file.");
          }
        })
      );

    new Setting(contentEl)
      .setName("Create missing accounts")
      .setDesc("Create an account for any account name in the CSV that doesn't already exist.")
      .addToggle((tg) => {
        tg.setValue(this.createMissingAccounts);
        tg.onChange((v) => (this.createMissingAccounts = v));
      });

    const actions = contentEl.createDiv("ft-modal-actions");
    const preview = actions.createEl("button", { text: "Preview" });
    preview.onclick = () => this.preview();
    const importBtn = actions.createEl("button", { text: "Import", cls: "mod-cta" });
    importBtn.onclick = () => this.doImport();
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();

    this.resultEl = contentEl.createDiv("ft-import-result");
  }

  private resultEl!: HTMLElement;

  private preview() {
    const { rows, skipped } = parseTransactionsCSV(this.csvText);
    this.resultEl.empty();
    if (rows.length === 0) {
      this.resultEl.createDiv({ cls: "ft-empty", text: "No valid rows found." });
      return;
    }
    const known = new Set(this.plugin.settings.accounts.map((a) => a.name.toLowerCase()));
    const unmatched = new Set<string>();
    rows.forEach((r) => {
      if (r.accountName && !known.has(r.accountName.toLowerCase())) unmatched.add(r.accountName);
      if (r.toAccountName && !known.has(r.toAccountName.toLowerCase())) unmatched.add(r.toAccountName);
    });
    this.resultEl.createDiv({ text: `${rows.length} valid rows` + (skipped ? `, ${skipped} skipped (bad date/amount)` : "") });
    if (unmatched.size > 0) {
      this.resultEl.createDiv({
        cls: "setting-item-description",
        text: `Unmatched accounts: ${Array.from(unmatched).join(", ")} — ${this.createMissingAccounts ? "will be created" : "will be left blank"}.`,
      });
    }
  }

  private async doImport() {
    const { rows, skipped } = parseTransactionsCSV(this.csvText);
    if (rows.length === 0) {
      new Notice("No valid rows to import.");
      return;
    }
    // resolve account names -> ids (case-insensitive), optionally creating
    const byName = new Map<string, string>();
    this.plugin.settings.accounts.forEach((a) => byName.set(a.name.toLowerCase(), a.id));
    const genId = () => Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    const resolve = (name?: string): string | undefined => {
      if (!name) return undefined;
      const key = name.toLowerCase();
      if (byName.has(key)) return byName.get(key);
      if (this.createMissingAccounts) {
        const id = genId();
        this.plugin.settings.accounts.push({ id, name, initialBalance: 0, active: true });
        byName.set(key, id);
        return id;
      }
      return undefined;
    };

    let added = 0;
    for (const r of rows) {
      const payload: Omit<Transaction, "id"> = {
        date: r.date,
        time: r.time,
        type: r.type,
        category: r.type === "transfer" ? "Transfer" : r.category || "Other",
        subcategory: r.subcategory || "",
        amount: r.amount,
        note: r.note || "",
        account: resolve(r.accountName),
        toAccount: r.type === "transfer" ? resolve(r.toAccountName) : undefined,
      };
      await this.plugin.store.add(payload);
      added++;
    }
    await this.plugin.saveSettings(); // persist any newly created accounts
    new Notice(`Imported ${added} transactions${skipped ? `, skipped ${skipped}` : ""}.`);
    this.onDone();
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}
