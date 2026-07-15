import { Plugin } from 'obsidian';
import {
	DEFAULT_BACKUP_EXPORT_PATH,
	DEFAULT_SETTINGS,
	type S3BackupSettings,
} from './settings';
import { S3BackupSettingTab } from './ui/settings-tab';

export default class S3SecureBackupPlugin extends Plugin {
	settings!: S3BackupSettings;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new S3BackupSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		const stored = ((await this.loadData()) ?? {}) as Partial<S3BackupSettings>;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);

		if (!this.settings.backupExportPath) {
			this.settings.backupExportPath = DEFAULT_BACKUP_EXPORT_PATH;
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
