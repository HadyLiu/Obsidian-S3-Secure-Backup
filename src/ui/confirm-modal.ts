import { Modal, Setting, type App } from 'obsidian';

export class ConfirmModal extends Modal {
	private accepted = false;
	private resolveWait: ((accepted: boolean) => void) | null = null;

	constructor(
		app: App,
		private readonly title: string,
		private readonly message: string,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h3', { text: this.title });
		contentEl.createEl('p', { text: this.message });

		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText('Cancel').onClick(() => {
					this.accepted = false;
					this.close();
				}),
			)
			.addButton((button) =>
				button
					.setButtonText('Continue')
					.setCta()
					.onClick(() => {
						this.accepted = true;
						this.close();
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
		const resolve = this.resolveWait;
		this.resolveWait = null;
		resolve?.(this.accepted);
	}

	openAndWait(): Promise<boolean> {
		this.accepted = false;
		return new Promise((resolve) => {
			this.resolveWait = resolve;
			this.open();
		});
	}
}
