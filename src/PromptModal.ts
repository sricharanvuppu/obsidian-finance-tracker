import { App, Modal, Setting } from "obsidian";

/** A minimal single-text-input prompt modal. */
export class PromptModal extends Modal {
  private title: string;
  private placeholder: string;
  private onSubmit: (value: string) => void;
  private value = "";

  constructor(app: App, title: string, placeholder: string, onSubmit: (value: string) => void) {
    super(app);
    this.title = title;
    this.placeholder = placeholder;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass("ft-modal");
    contentEl.createEl("h3", { text: this.title });

    const setting = new Setting(contentEl).addText((t) => {
      t.setPlaceholder(this.placeholder);
      t.onChange((v) => (this.value = v));
      t.inputEl.style.width = "100%";
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.submit();
        }
      });
      window.setTimeout(() => t.inputEl.focus(), 30);
    });
    setting.settingEl.style.border = "none";
    setting.settingEl.style.padding = "0";

    const actions = contentEl.createDiv("ft-modal-actions");
    const ok = actions.createEl("button", { text: "Add", cls: "mod-cta" });
    ok.onclick = () => this.submit();
    const cancel = actions.createEl("button", { text: "Cancel" });
    cancel.onclick = () => this.close();
  }

  private submit() {
    const v = this.value.trim();
    if (v) this.onSubmit(v);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}
