import { Notice, Plugin } from 'obsidian';
import { BackupEngine, type BackupResult } from './backup/backup-engine';
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
	private backupEngine!: BackupEngine;
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
			this.app,
			this.app.vault,
			this.app.vault.configDir,
			this.metadataStore,
			() => this.settings,
		);
		this.backupEngine = new BackupEngine(
			this.app.vault,
			this.metadataStore,
			() => this.settings,
		);

		this.addSettingTab(new S3BackupSettingTab(this.app, this));
		this.addCommand({
			id: 'sync-now',
			name: 'Sync with S3 now',
			callback: () => {
				void this.runManualSync();
			},
		});
		this.addCommand({
			id: 'daily-backup-now',
			name: 'Run daily diff backup now',
			callback: () => {
				void this.runManualDailyBackup();
			},
		});

		this.refreshSyncTimer();
		this.register(() => this.stopSyncTimer());
		this.app.workspace.onLayoutReady(() => {
			void this.runStartupTasks();
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

	private async runStartupTasks(): Promise<void> {
		if (!hasCompleteConnectionSettings(this.settings)) {
			return;
		}

		await this.runBackgroundSync();
		await this.runDailyBackupIfDue();
	}

	private async runManualDailyBackup(): Promise<void> {
		try {
			const result = await this.backupEngine.run();
			if (result.errors.length > 0) {
				console.error('S3 daily backup errors:', result.errors);
			}
			new Notice(
				formatBackupResult(result),
				result.errors.length > 0 ? 12000 : 5000,
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : 'Unknown backup error.';
			console.error('S3 daily backup failed:', error);
			new Notice(`S3 daily backup failed: ${message}`, 8000);
		}
	}

	private async runDailyBackupIfDue(): Promise<void> {
		if (this.backupEngine.isRunning || this.syncEngine.isRunning) {
			return;
		}

		try {
			const result = await this.backupEngine.runIfDue();
			if (!result) {
				return;
			}
			if (result.errors.length > 0) {
				console.error('S3 daily backup completed with errors:', result.errors);
				return;
			}
		} catch (error) {
			console.error('S3 daily backup failed:', error);
		}
	}

	private async runManualSync(): Promise<void> {
		try {
			const result = await this.syncEngine.sync();
			if (result.errors.length > 0) {
				console.error('S3 backup errors:', result.errors);
			}
			new Notice(
				formatSyncResult(result),
				result.errors.length > 0 ? 12000 : 5000,
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : 'Unknown sync error.';
			console.error('S3 backup failed:', error);
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

function formatBackupResult(result: BackupResult): string {
	const summary =
		`Daily backup complete: ${result.backedUp} file(s) uploaded, ` +
		`${result.skipped} skipped.`;
	if (result.errors.length === 0) {
		return summary;
	}

	const firstError = result.errors[0] ?? 'Unknown error';
	return `${summary} ${result.errors.length} error(s). First error: ${firstError}`;
}

function formatSyncResult(result: SyncResult): string {
	const summary =
		`S3 sync complete: ${result.pulled} pulled, ` +
		`${result.uploaded} uploaded, ${result.conflicts} conflict(s), ` +
		`${result.localDeleted} local deleted, ${result.deleted} remote deleted, ` +
		`${result.skipped} unchanged.`;
	if (result.errors.length === 0) {
		return summary;
	}

	const firstError = result.errors[0] ?? 'Unknown error';
	return (
		`${summary} ${result.errors.length} error(s); ` +
		`${result.pendingDeletes} deletion(s) pending retry. ` +
		`First error: ${firstError}`
	);
}
