import { Notice, Plugin } from 'obsidian';
import { MetadataStore } from './database/metadata-store';
import {
	DEFAULT_BACKUP_EXPORT_PATH,
	DEFAULT_SETTINGS,
	clampSyncInterval,
	type S3BackupSettings,
} from './settings';
import { SyncEngine, type SyncResult } from './sync/sync-engine';
import { S3BackupSettingTab } from './ui/settings-tab';

export default class S3SecureBackupPlugin extends Plugin {
	settings!: S3BackupSettings;
	private metadataStore!: MetadataStore;
	private syncEngine!: SyncEngine;
	private syncIntervalId: number | null = null;
	private scheduledIntervalSeconds = 0;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.metadataStore = new MetadataStore(
			this.app.vault.adapter,
			this.app.vault.configDir,
			this.manifest.id,
		);
		await this.metadataStore.load();
		this.syncEngine = new SyncEngine(
			this.app.vault,
			this.app.vault.configDir,
			this.metadataStore,
			() => this.settings,
		);

		this.addSettingTab(new S3BackupSettingTab(this.app, this));
		this.addCommand({
			id: 'sync-now',
			name: 'Sync to S3 now',
			callback: () => {
				void this.runManualSync();
			},
		});

		this.refreshSyncTimer();
		this.register(() => this.stopSyncTimer());
		this.app.workspace.onLayoutReady(() => {
			void this.runBackgroundSync();
		});
	}

	async loadSettings(): Promise<void> {
		const stored = ((await this.loadData()) ?? {}) as Partial<S3BackupSettings>;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);

		if (!this.settings.backupExportPath) {
			this.settings.backupExportPath = DEFAULT_BACKUP_EXPORT_PATH;
		}
		this.settings.syncIntervalSeconds = clampSyncInterval(
			this.settings.syncIntervalSeconds,
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.refreshSyncTimer();
	}

	private refreshSyncTimer(): void {
		const intervalSeconds = this.settings.syncIntervalSeconds;
		if (
			this.syncIntervalId !== null &&
			this.scheduledIntervalSeconds === intervalSeconds
		) {
			return;
		}

		this.stopSyncTimer();
		this.scheduledIntervalSeconds = intervalSeconds;
		this.syncIntervalId = window.setInterval(() => {
			void this.runBackgroundSync();
		}, intervalSeconds * 1000);
	}

	private stopSyncTimer(): void {
		if (this.syncIntervalId !== null) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
		}
	}

	private async runManualSync(): Promise<void> {
		try {
			const result = await this.syncEngine.sync();
			new Notice(formatSyncResult(result), result.errors.length > 0 ? 8000 : 5000);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : 'Unknown sync error.';
			new Notice(`S3 backup failed: ${message}`, 8000);
		}
	}

	private async runBackgroundSync(): Promise<void> {
		if (!hasCompleteConnectionSettings(this.settings) || this.syncEngine.isRunning) {
			return;
		}

		try {
			const result = await this.syncEngine.sync();
			if (result.errors.length > 0) {
				console.error('S3 backup completed with errors:', result.errors);
			}
		} catch (error) {
			console.error('S3 background backup failed:', error);
		}
	}
}

function hasCompleteConnectionSettings(settings: S3BackupSettings): boolean {
	return Boolean(
		settings.endpoint.trim() &&
			settings.bucket.trim() &&
			settings.accessKeyId.trim() &&
			settings.secretAccessKey.trim(),
	);
}

function formatSyncResult(result: SyncResult): string {
	const summary =
		`S3 backup complete: ${result.uploaded} uploaded, ` +
		`${result.deleted} deleted, ${result.skipped} unchanged.`;
	if (result.errors.length === 0) {
		return summary;
	}
	return `${summary} ${result.errors.length} error(s); ` +
		`${result.pendingDeletes} deletion(s) pending retry.`;
}
