import { Notice, Plugin, type WorkspaceLeaf } from 'obsidian';
import { BackupEngine, type BackupResult } from './backup/backup-engine';
import { MetadataStore } from './database/metadata-store';
import { BackupExportService } from './services/backup-export-service';
import { TrashService } from './services/trash-service';
import {
	DEFAULT_BACKUP_EXPORT_PATH,
	DEFAULT_SETTINGS,
	clampSyncInterval,
	type S3BackupSettings,
} from './settings';
import { SyncEngine, type SyncResult } from './sync/sync-engine';
import { MANAGER_VIEW_TYPE } from './ui/constants';
import { BackupManagerView } from './ui/manager-view';
import { S3BackupSettingTab } from './ui/settings-tab';

export default class S3SecureBackupPlugin extends Plugin {
	settings!: S3BackupSettings;
	private metadataStore!: MetadataStore;
	private syncEngine!: SyncEngine;
	private backupEngine!: BackupEngine;
	private trashService!: TrashService;
	private backupExportService!: BackupExportService;
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
		this.trashService = new TrashService(
			this.app,
			this.app.vault,
			this.app.vault.configDir,
			() => this.settings,
		);
		this.backupExportService = new BackupExportService(
			this.app,
			this.app.vault,
			() => this.settings,
		);

		this.registerView(MANAGER_VIEW_TYPE, (leaf) => this.createManagerView(leaf));

		this.addRibbonIcon('cloud', 'S3 secure backup', () => {
			void this.runRibbonSync();
		});

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
		this.addCommand({
			id: 'open-manager',
			name: 'Open trash & backup manager',
			callback: () => {
				void this.activateManagerView();
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

	private createManagerView(leaf: WorkspaceLeaf): BackupManagerView {
		const view = new BackupManagerView(leaf);
		view.bindServices({
			trashService: this.trashService,
			backupExportService: this.backupExportService,
			getSettings: () => this.settings,
			hasConnectionSettings: () =>
				hasCompleteConnectionSettings(this.settings),
		});
		return view;
	}

	private async activateManagerView(): Promise<WorkspaceLeaf | null> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(MANAGER_VIEW_TYPE)[0];
		if (existing) {
			await workspace.revealLeaf(existing);
			return existing;
		}

		const leaf = workspace.getRightLeaf(false);
		if (!leaf) {
			return null;
		}
		await leaf.setViewState({
			type: MANAGER_VIEW_TYPE,
			active: true,
		});
		await workspace.revealLeaf(leaf);
		return leaf;
	}

	private async refreshManagerView(): Promise<void> {
		const leaves = this.app.workspace.getLeavesOfType(MANAGER_VIEW_TYPE);
		await Promise.all(
			leaves.map(async (leaf) => {
				const view = leaf.view;
				if (view instanceof BackupManagerView) {
					await view.refreshData();
				}
			}),
		);
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

	private async runRibbonSync(): Promise<void> {
		await this.activateManagerView();
		await this.runManualSync();
		await this.refreshManagerView();
	}

	private async runManualDailyBackup(): Promise<void> {
		try {
			const result = await this.backupEngine.run();
			if (result.errors.length > 0) {
				console.error(
					`S3 daily backup completed with ${result.errors.length} error(s).`,
				);
			}
			new Notice(
				formatBackupResult(result),
				result.errors.length > 0 ? 12000 : 5000,
			);
			await this.refreshManagerView();
		} catch {
			console.error('S3 daily backup failed.');
			new Notice('S3 daily backup failed. Check settings and permissions.', 8000);
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
				console.error(
					`S3 daily backup completed with ${result.errors.length} error(s).`,
				);
				return;
			}
			await this.refreshManagerView();
		} catch {
			console.error('S3 daily backup failed.');
		}
	}

	private logSyncErrors(result: SyncResult): void {
		if (result.errors.length === 0) {
			return;
		}

		console.error(
			`S3 sync completed with ${result.errors.length} error(s):`,
		);
		for (const error of result.errors) {
			console.error(`  ${error}`);
		}
	}

	private logSyncWarnings(result: SyncResult): void {
		if (result.warnings.length === 0) {
			return;
		}

		console.warn(
			`S3 sync reported ${result.warnings.length} warning(s):`,
		);
		for (const warning of result.warnings) {
			console.warn(`  ${warning}`);
		}
	}

	private async runManualSync(): Promise<void> {
		try {
			const result = await this.syncEngine.sync();
			this.logSyncWarnings(result);
			this.logSyncErrors(result);
			new Notice(
				formatSyncResult(result),
				hasSyncAlerts(result) ? 12000 : 5000,
			);
			await this.refreshManagerView();
		} catch (error) {
			console.error('S3 backup failed.', error);
			new Notice('S3 backup failed. Check settings and permissions.', 8000);
		}
	}

	private async runBackgroundSync(): Promise<void> {
		if (!hasCompleteConnectionSettings(this.settings) || this.syncEngine.isRunning) {
			return;
		}

		try {
			const result = await this.syncEngine.sync();
			this.logSyncWarnings(result);
			this.logSyncErrors(result);
		} catch (error) {
			console.error('S3 background backup failed.', error);
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

	return `${summary} ${result.errors.length} error(s).`;
}

function formatSyncResult(result: SyncResult): string {
	const warningSuffix =
		result.warnings.length > 0 ? ` ${formatSyncWarnings(result.warnings)}` : '';

	if (result.bootstrap) {
		const bootstrapSummary =
			`S3 bootstrap complete: ${result.pulled} downloaded, ` +
			`${result.uploaded} uploaded, ${result.conflicts} conflict(s)` +
			(result.pathCollisions > 0
				? `, ${result.pathCollisions} path collision(s) skipped`
				: '') +
			'.';
		if (result.errors.length === 0) {
			return `${bootstrapSummary}${warningSuffix}`;
		}
		return `${bootstrapSummary} ${formatSyncErrors(result.errors)}${warningSuffix}`;
	}

	const summary =
		`S3 sync complete: ${result.pulled} pulled, ` +
		`${result.uploaded} uploaded, ${result.conflicts} conflict(s), ` +
		`${result.localDeleted} local deleted, ${result.deleted} remote deleted, ` +
		`${result.skipped} unchanged` +
		(result.pathCollisions > 0
			? `, ${result.pathCollisions} path collision(s) skipped`
			: '') +
		'.';
	if (result.errors.length === 0) {
		return `${summary}${warningSuffix}`;
	}

	return (
		`${summary} ${formatSyncErrors(result.errors)}; ` +
		`${result.pendingDeletes} deletion(s) pending retry.${warningSuffix}`
	);
}

function formatSyncWarnings(warnings: string[]): string {
	if (warnings.length === 1) {
		return `Warning: ${warnings[0]}`;
	}

	const preview = warnings.slice(0, 1).join('; ');
	const suffix =
		warnings.length > 1 ? ` (+${warnings.length - 1} more in console)` : '';
	return `Warnings: ${preview}${suffix}`;
}

function hasSyncAlerts(result: SyncResult): boolean {
	return result.errors.length > 0 || result.warnings.length > 0;
}

function formatSyncErrors(errors: string[]): string {
	if (errors.length === 1) {
		return `1 error: ${errors[0]}`;
	}

	const preview = errors.slice(0, 2).join('; ');
	const suffix =
		errors.length > 2 ? ` (+${errors.length - 2} more in console)` : '';
	return `${errors.length} errors: ${preview}${suffix}`;
}
