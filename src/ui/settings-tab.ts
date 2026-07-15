import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import { testBucketConnection } from '../s3/client';
import {
	clampSyncInterval,
	formatClipboardConfig,
	MIN_SYNC_INTERVAL_SECONDS,
	parseClipboardConfig,
	type S3BackupSettings,
} from '../settings';
import type S3SecureBackupPlugin from '../main';

function showSuccessNotice(message: string): void {
	const notice = new Notice('', 4000);
	notice.noticeEl.empty();
	notice.noticeEl.createSpan({
		cls: 's3-backup-notice--success',
		text: message,
	});
}

function showErrorNotice(message: string): void {
	const notice = new Notice('', 6000);
	notice.noticeEl.empty();
	notice.noticeEl.createSpan({
		cls: 's3-backup-notice--error',
		text: message,
	});
}

export class S3BackupSettingTab extends PluginSettingTab {
	plugin: S3SecureBackupPlugin;

	constructor(app: App, plugin: S3SecureBackupPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('S3 connection').setHeading();

		this.addTextSetting('endpoint', 'Endpoint', 'https://account.r2.cloudflarestorage.com');
		this.addTextSetting('region', 'Region', 'auto');
		this.addTextSetting('bucket', 'Bucket', 'my-vault-backup');
		this.addTextSetting('accessKeyId', 'Access key ID', '');
		this.addSecretSetting('secretAccessKey', 'Secret access key');

		new Setting(containerEl).setName('Sync').setHeading();

		new Setting(containerEl)
			.setName('Sync interval (seconds)')
			.setDesc(`Minimum ${MIN_SYNC_INTERVAL_SECONDS} seconds.`)
			.addText((text) =>
				text
					.setPlaceholder(String(MIN_SYNC_INTERVAL_SECONDS))
					.setValue(String(this.plugin.settings.syncIntervalSeconds))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						this.plugin.settings.syncIntervalSeconds =
							clampSyncInterval(parsed);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Backup export path')
			.setDesc('Folder inside the vault for exported backups.')
			.addText((text) =>
				text
					.setPlaceholder('Export folder path')
					.setValue(this.plugin.settings.backupExportPath)
					.onChange(async (value) => {
						this.plugin.settings.backupExportPath = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('Clipboard').setHeading();

		new Setting(containerEl)
			.setName('Import from clipboard')
			.setDesc('Parse endpoint, region, bucket, credentials, and sync interval from clipboard.')
			.addButton((button) =>
				button.setButtonText('Import').onClick(() => {
					void this.importFromClipboard();
				}),
			);

		new Setting(containerEl)
			.setName('Copy to clipboard')
			.setDesc('Copy current S3 settings as a single-line query string.')
			.addButton((button) =>
				button.setButtonText('Copy').onClick(() => {
					void this.copyToClipboard();
				}),
			);

		new Setting(containerEl).setName('Connection test').setHeading();

		new Setting(containerEl)
			.setName('Test bucket')
			.setDesc('Send list objects request (max 1 key) to verify bucket connectivity.')
			.addButton((button) =>
				button.setButtonText('Test').onClick(() => {
					void this.testBucket();
				}),
			);

		const configDir = this.app.vault.configDir;
		const warningEl = containerEl.createDiv({ cls: 's3-backup-security-warning' });
		warningEl.createEl('strong', { text: 'Security warning' });
		warningEl.createEl('p', {
			text: `Plugin settings are stored in plain text at ${configDir}/plugins/.../data.json. If you back up your vault with Git, add this line to your vault root .gitignore:`,
		});
		warningEl.createEl('code', {
			text: `${configDir}/plugins/*/data.json`,
		});
	}

	private addTextSetting(
		key: keyof Pick<
			S3BackupSettings,
			'endpoint' | 'region' | 'bucket' | 'accessKeyId'
		>,
		name: string,
		placeholder: string,
	): void {
		new Setting(this.containerEl)
			.setName(name)
			.addText((text) =>
				text
					.setPlaceholder(placeholder)
					.setValue(this.plugin.settings[key])
					.onChange(async (value) => {
						this.plugin.settings[key] = value;
						await this.plugin.saveSettings();
					}),
			);
	}

	private addSecretSetting(
		key: 'secretAccessKey',
		name: string,
	): void {
		new Setting(this.containerEl)
			.setName(name)
			.addText((text) => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('••••••••')
					.setValue(this.plugin.settings[key])
					.onChange(async (value) => {
						this.plugin.settings[key] = value;
						await this.plugin.saveSettings();
					});
			});
	}

	private async importFromClipboard(): Promise<void> {
		try {
			const clipboardText = await navigator.clipboard.readText();
			const parsed = parseClipboardConfig(clipboardText);
			const keys = Object.keys(parsed) as (keyof S3BackupSettings)[];

			if (keys.length === 0) {
				showErrorNotice('No valid configuration found in clipboard.');
				return;
			}

			Object.assign(this.plugin.settings, parsed);
			await this.plugin.saveSettings();
			this.display();
			showSuccessNotice(`Imported ${keys.length} setting(s) from clipboard.`);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : 'Failed to read clipboard.';
			showErrorNotice(message);
		}
	}

	private async copyToClipboard(): Promise<void> {
		try {
			const payload = formatClipboardConfig(this.plugin.settings);
			await navigator.clipboard.writeText(payload);
			showSuccessNotice('Configuration copied to clipboard.');
		} catch (error) {
			const message =
				error instanceof Error ? error.message : 'Failed to write clipboard.';
			showErrorNotice(message);
		}
	}

	private async testBucket(): Promise<void> {
		const result = await testBucketConnection(this.plugin.settings);
		if (result.ok) {
			showSuccessNotice('Bucket connection successful.');
			return;
		}
		showErrorNotice(`Bucket connection failed: ${result.message}`);
	}
}
