import { ItemView, Notice, Setting, type WorkspaceLeaf } from 'obsidian';
import type { BackupExportService, BackupPackage } from '../services/backup-export-service';
import type { TrashService } from '../services/trash-service';
import type { TrashFolderNode, TrashItem } from '../services/trash-tree';
import type { S3BackupSettings } from '../settings';
import { MANAGER_VIEW_TYPE } from './constants';

export class BackupManagerView extends ItemView {
	private trashService!: TrashService;
	private backupExportService!: BackupExportService;
	private getSettings!: () => S3BackupSettings;
	private hasConnectionSettings!: () => boolean;

	private trashRoot: TrashFolderNode | null = null;
	private packages: BackupPackage[] = [];
	private selectedDates = new Set<string>();
	private statusText = 'Ready';
	private progressPercent = 0;
	private loading = false;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	bindServices(options: {
		trashService: TrashService;
		backupExportService: BackupExportService;
		getSettings: () => S3BackupSettings;
		hasConnectionSettings: () => boolean;
	}): void {
		this.trashService = options.trashService;
		this.backupExportService = options.backupExportService;
		this.getSettings = options.getSettings;
		this.hasConnectionSettings = options.hasConnectionSettings;
	}

	getViewType(): string {
		return MANAGER_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'S3 backup manager';
	}

	getIcon(): string {
		return 'cloud';
	}

	async onOpen(): Promise<void> {
		await this.refreshData();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	async refreshData(): Promise<void> {
		if (!this.trashService || !this.backupExportService) {
			return;
		}

		this.loading = true;
		this.statusText = 'Loading cloud data...';
		this.render();

		try {
			if (!this.hasConnectionSettings()) {
				this.trashRoot = null;
				this.packages = [];
				this.statusText = 'Configure S3 settings first.';
				return;
			}

			this.trashRoot = await this.trashService.listTrashTree();
			this.packages = await this.backupExportService.listRecentPackages(7);
			this.statusText = 'Ready';
		} catch (error) {
			const message =
				error instanceof Error ? error.message : 'Failed to load manager data.';
			this.statusText = message;
			console.error('S3 manager refresh failed:', error);
		} finally {
			this.loading = false;
			this.render();
		}
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('s3-backup-manager');

		const header = contentEl.createDiv({ cls: 's3-backup-manager__header' });
		header.createEl('h4', { text: 'Trash & backup manager' });
		new Setting(header)
			.setName('Refresh')
			.setDesc('Reload trash and backup packages from the cloud.')
			.addButton((button) => {
				button.setButtonText(this.loading ? 'Loading...' : 'Refresh');
				button.buttonEl.disabled = this.loading;
				button.onClick(() => {
					void this.refreshData();
				});
			});

		contentEl.createDiv({
			cls: 's3-backup-manager__status',
			text: this.statusText,
		});

		this.renderTrashSection(contentEl);
		this.renderBackupSection(contentEl);
	}

	private renderTrashSection(container: HTMLElement): void {
		const section = container.createDiv({ cls: 's3-backup-manager__section' });
		section.createEl('h5', { text: 'Trash explorer' });

		if (!this.trashRoot || (
			this.trashRoot.items.length === 0 &&
			this.trashRoot.folders.length === 0
		)) {
			section.createEl('p', {
				cls: 's3-backup-manager__empty',
				text: 'No files in cloud trash.',
			});
			return;
		}

		const list = section.createDiv({ cls: 's3-backup-manager__tree' });
		this.renderTrashFolder(list, this.trashRoot, 0);
	}

	private renderTrashFolder(
		container: HTMLElement,
		folder: TrashFolderNode,
		depth: number,
	): void {
		if (folder.path) {
			container.createDiv({
				cls: 's3-backup-manager__folder',
				text: `${'  '.repeat(depth)}${folder.name}/`,
			});
		}

		for (const child of folder.folders) {
			this.renderTrashFolder(container, child, depth + (folder.path ? 1 : 0));
		}

		for (const item of folder.items) {
			this.renderTrashItem(
				container,
				item,
				depth + (folder.path ? 1 : 0),
			);
		}
	}

	private renderTrashItem(
		container: HTMLElement,
		item: TrashItem,
		depth: number,
	): void {
		const row = container.createDiv({ cls: 's3-backup-manager__item' });
		row.createSpan({
			cls: 's3-backup-manager__item-name',
			text: `${'  '.repeat(depth)}${item.name}`,
		});
		row.createSpan({
			cls: 's3-backup-manager__item-path',
			text: item.originalPath,
		});
		const restoreButton = row.createEl('button', {
			cls: 'mod-cta s3-backup-manager__restore',
			text: 'Restore',
		});
		restoreButton.addEventListener('click', () => {
			void this.restoreItem(item);
		});
	}

	private async restoreItem(item: TrashItem): Promise<void> {
		try {
			this.statusText = `Restoring ${item.name}...`;
			this.render();
			const restoredPath = await this.trashService.restoreItem(item);
			new Notice(`Restored to ${restoredPath}`);
			await this.refreshData();
		} catch (error) {
			const message =
				error instanceof Error ? error.message : 'Restore failed.';
			this.statusText = message;
			new Notice(`Restore failed: ${message}`, 8000);
			this.render();
		}
	}

	private renderBackupSection(container: HTMLElement): void {
		const section = container.createDiv({ cls: 's3-backup-manager__section' });
		section.createEl('h5', { text: 'Backup manager' });

		if (this.packages.length === 0) {
			section.createEl('p', {
				cls: 's3-backup-manager__empty',
				text: 'No recent backup packages found.',
			});
			return;
		}

		for (const backupPackage of this.packages) {
			const row = section.createDiv({ cls: 's3-backup-manager__backup-row' });
			const label = row.createEl('label');
			const checkbox = label.createEl('input', { type: 'checkbox' });
			checkbox.checked = this.selectedDates.has(backupPackage.dateKey);
			checkbox.disabled = backupPackage.objectCount === 0 || this.loading;
			checkbox.addEventListener('change', () => {
				if (checkbox.checked) {
					this.selectedDates.add(backupPackage.dateKey);
				} else {
					this.selectedDates.delete(backupPackage.dateKey);
				}
			});
			label.createSpan({
				text: `${backupPackage.displayDate} (${backupPackage.objectCount} file(s))`,
			});
		}

		const progressWrap = section.createDiv({
			cls: 's3-backup-manager__progress',
		});
		const progressBar = progressWrap.createEl('progress');
		progressBar.max = 100;
		progressBar.value = this.progressPercent;

		new Setting(section)
			.setName('Export backup')
			.setDesc('Download selected daily packages as a zip file.')
			.addButton((button) => {
				button.setButtonText('Export backup').setCta();
				button.buttonEl.disabled = this.loading;
				button.onClick(() => {
					void this.exportSelectedBackups();
				});
			});
	}

	private async exportSelectedBackups(): Promise<void> {
		const selected = [...this.selectedDates];
		if (selected.length === 0) {
			new Notice('Select at least one backup date.');
			return;
		}

		this.loading = true;
		this.progressPercent = 0;
		this.statusText = 'Exporting backups...';
		this.render();

		try {
			const exportPath = this.getSettings().backupExportPath || 'Backup_Export/';
			const outputPath = await this.backupExportService.exportPackages(
				selected,
				exportPath,
				(progress) => {
					this.progressPercent =
						progress.total === 0
							? 0
							: Math.round((progress.completed / progress.total) * 100);
					this.statusText =
						`Exporting ${progress.completed}/${progress.total}: ${progress.currentFile}`;
					this.render();
				},
			);
			this.progressPercent = 100;
			this.statusText = `Exported to ${outputPath}`;
			new Notice(`Backup exported to ${outputPath}`);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : 'Export failed.';
			this.statusText = message;
			new Notice(`Export failed: ${message}`, 8000);
		} finally {
			this.loading = false;
			this.render();
		}
	}
}
