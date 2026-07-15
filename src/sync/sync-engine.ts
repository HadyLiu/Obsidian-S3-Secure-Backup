import type { TFile, Vault } from 'obsidian';
import type {
	FileRecord,
	MetadataStore,
	PendingDelete,
} from '../database/metadata-store';
import type { S3BackupSettings } from '../settings';
import { formatS3Error } from '../s3/client';
import { S3StorageService } from '../s3/storage-service';
import { calculateMd5 } from './checksum';

export interface SyncResult {
	uploaded: number;
	metadataUpdated: number;
	deleted: number;
	skipped: number;
	pendingDeletes: number;
	errors: string[];
}

export class SyncEngine {
	private running = false;

	constructor(
		private readonly vault: Vault,
		private readonly configDir: string,
		private readonly metadataStore: MetadataStore,
		private readonly getSettings: () => S3BackupSettings,
	) {}

	get isRunning(): boolean {
		return this.running;
	}

	async sync(): Promise<SyncResult> {
		if (this.running) {
			throw new Error('A backup sync is already running.');
		}

		const settings = this.getSettings();
		validateSettings(settings);
		this.running = true;
		const storage = new S3StorageService(settings);
		const result = createSyncResult();

		try {
			const localFiles = this.scanLocalFiles();
			await this.reconcileDeleteQueue(localFiles);
			await this.syncLocalFiles(localFiles, storage, result);
			await this.processPendingDeletes(storage, result);
			await this.metadataStore.save();
			result.pendingDeletes =
				this.metadataStore.database.pending_deletes.length;
			return result;
		} finally {
			storage.destroy();
			this.running = false;
		}
	}

	private scanLocalFiles(): Map<string, TFile> {
		const configPrefix = `${this.configDir}/`;
		const files = new Map<string, TFile>();
		for (const file of this.vault.getFiles()) {
			if (file.path === this.configDir || file.path.startsWith(configPrefix)) {
				continue;
			}
			files.set(file.path, file);
		}
		return files;
	}

	private async reconcileDeleteQueue(
		localFiles: Map<string, TFile>,
	): Promise<void> {
		const database = this.metadataStore.database;

		// A file recreated before deletion processing must not be removed remotely.
		database.pending_deletes = database.pending_deletes.filter((pending) =>
			!localFiles.has(pending.path),
		);

		const queuedPaths = new Set(
			database.pending_deletes.map((pending) => pending.path),
		);
		for (const path of Object.keys(database.files)) {
			if (localFiles.has(path) || queuedPaths.has(path)) {
				continue;
			}
			database.pending_deletes.push(createPendingDelete(path));
		}

		// Persist intent before any cloud-side copy/delete transaction begins.
		await this.metadataStore.save();
	}

	private async syncLocalFiles(
		localFiles: Map<string, TFile>,
		storage: S3StorageService,
		result: SyncResult,
	): Promise<void> {
		const records = this.metadataStore.database.files;

		for (const [path, file] of localFiles) {
			const previous = records[path];
			if (
				previous &&
				previous.mtime === file.stat.mtime &&
				previous.size === file.stat.size
			) {
				result.skipped += 1;
				continue;
			}

			try {
				const content = await this.vault.readBinary(file);
				const checksum = calculateMd5(content);

				if (previous?.md5 === checksum.hex) {
					records[path] = createFileRecord(file, checksum.hex);
					result.metadataUpdated += 1;
					continue;
				}

				await storage.upload(path, content, checksum.base64);
				records[path] = createFileRecord(file, checksum.hex);
				result.uploaded += 1;
			} catch (error) {
				result.errors.push(`${path}: ${formatError(error)}`);
			}
		}
	}

	private async processPendingDeletes(
		storage: S3StorageService,
		result: SyncResult,
	): Promise<void> {
		const database = this.metadataStore.database;
		const pendingItems = [...database.pending_deletes];

		for (const pending of pendingItems) {
			// Recheck immediately before cloud mutation to reduce filesystem race risk.
			if (this.vault.getAbstractFileByPath(pending.path)) {
				database.pending_deletes = database.pending_deletes.filter(
					(item) => item.path !== pending.path,
				);
				await this.metadataStore.save();
				continue;
			}

			try {
				if (!pending.copyCompleted) {
					await storage.copyToWaste(pending.path, pending.wasteKey);
					pending.copyCompleted = true;
					delete pending.lastError;
					// Durably open the delete gate only after CopyObject succeeds.
					await this.metadataStore.save();
				}

				await storage.delete(pending.path);
				delete database.files[pending.path];
				database.pending_deletes = database.pending_deletes.filter(
					(item) => item.path !== pending.path,
				);
				result.deleted += 1;
				await this.metadataStore.save();
			} catch (error) {
				pending.lastError = formatError(error);
				result.errors.push(
					`${pending.path} delete transaction: ${pending.lastError}`,
				);
				await this.metadataStore.save();
			}
		}
	}
}

function validateSettings(settings: S3BackupSettings): void {
	if (
		!settings.endpoint.trim() ||
		!settings.bucket.trim() ||
		!settings.accessKeyId.trim() ||
		!settings.secretAccessKey.trim()
	) {
		throw new Error('Complete the S3 connection settings before syncing.');
	}
}

function createSyncResult(): SyncResult {
	return {
		uploaded: 0,
		metadataUpdated: 0,
		deleted: 0,
		skipped: 0,
		pendingDeletes: 0,
		errors: [],
	};
}

function createFileRecord(file: TFile, md5: string): FileRecord {
	return {
		path: file.path,
		mtime: file.stat.mtime,
		size: file.stat.size,
		md5,
	};
}

function createPendingDelete(path: string): PendingDelete {
	const deletedAt = Date.now();
	return {
		path,
		wasteKey: createWasteKey(path, new Date(deletedAt)),
		deletedAt,
		copyCompleted: false,
	};
}

function createWasteKey(path: string, deletedAt: Date): string {
	const separatorIndex = path.lastIndexOf('/');
	const directory =
		separatorIndex >= 0 ? `${path.slice(0, separatorIndex)}/` : '';
	const filename =
		separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
	return `.wastePaper/${directory}${formatTimestamp(deletedAt)}_${filename}`;
}

function formatTimestamp(date: Date): string {
	const year = String(date.getFullYear());
	const month = padTwoDigits(date.getMonth() + 1);
	const day = padTwoDigits(date.getDate());
	const hour = padTwoDigits(date.getHours());
	const minute = padTwoDigits(date.getMinutes());
	const second = padTwoDigits(date.getSeconds());
	return `${year}${month}${day}_${hour}${minute}${second}`;
}

function padTwoDigits(value: number): string {
	return String(value).padStart(2, '0');
}

function formatError(error: unknown): string {
	return formatS3Error(error);
}
