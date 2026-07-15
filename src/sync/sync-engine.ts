import { type App, TFile, type Vault } from 'obsidian';
import type { FileRecord, MetadataStore } from '../database/metadata-store';
import {
	validateS3Endpoint,
	validateVaultRelativePath,
} from '../security/validation';
import type { S3BackupSettings } from '../settings';
import { formatS3Error } from '../s3/client';
import type { CloudObject } from '../s3/storage-service';
import { S3StorageService } from '../s3/storage-service';
import { calculateMd5 } from './checksum';
import { etagToMd5 } from './etag';
import { createConflictPath, createWasteKey } from './paths';

export interface SyncResult {
	bootstrap: boolean;
	pulled: number;
	conflicts: number;
	localDeleted: number;
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
		private readonly app: App,
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
			if (await this.runBootstrapIfNeeded(storage, result)) {
				result.pendingDeletes =
					this.metadataStore.database.pending_deletes.length;
				return result;
			}

			const localFiles = this.scanLocalFiles();
			const cloudObjects = await storage.listVaultObjects();
			const cloudIndex = new Map(
				cloudObjects.map((object) => [object.key, object]),
			);

			await this.pullCloudChanges(
				cloudIndex,
				localFiles,
				storage,
				result,
			);
			await this.reconcileDeleteQueue(this.scanLocalFiles());
			await this.pushLocalChanges(this.scanLocalFiles(), storage, result);

			const deletesCompleted = await this.processPendingDeletes(
				storage,
				result,
			);
			if (!deletesCompleted) {
				await this.metadataStore.save();
				result.pendingDeletes =
					this.metadataStore.database.pending_deletes.length;
				return result;
			}

			if (result.errors.length === 0) {
				this.metadataStore.database.last_sync_time = Date.now();
			}

			await this.metadataStore.save();
			result.pendingDeletes =
				this.metadataStore.database.pending_deletes.length;
			return result;
		} finally {
			storage.destroy();
			this.running = false;
		}
	}

	private needsBootstrap(): boolean {
		const database = this.metadataStore.database;
		return (
			Object.keys(database.files).length === 0 ||
			database.last_sync_time === 0
		);
	}

	/**
	 * First-run full pull: download every cloud object with conflict protection,
	 * rebuild the local index, update last_sync_time, then end this sync cycle.
	 * Local-only files are left for the next regular sync to push.
	 */
	private async runBootstrapIfNeeded(
		storage: S3StorageService,
		result: SyncResult,
	): Promise<boolean> {
		if (!this.needsBootstrap()) {
			return false;
		}

		result.bootstrap = true;
		const cloudObjects = await storage.listVaultObjects();
		const localFiles = this.scanLocalFiles();

		for (const cloud of cloudObjects) {
			try {
				validateVaultRelativePath(cloud.key, this.configDir);
				const outcome = await this.applyCloudObject(
					cloud.key,
					cloud,
					localFiles.get(cloud.key),
					storage,
					{ allowConflict: true },
				);
				if (outcome === 'pulled') {
					result.pulled += 1;
				} else if (outcome === 'conflict') {
					result.conflicts += 1;
				} else {
					result.skipped += 1;
				}
			} catch (error) {
				result.errors.push(
					`${cloud.key} bootstrap: ${formatError(error)}`,
				);
			}
		}

		if (result.errors.length === 0) {
			this.metadataStore.database.last_sync_time = Date.now();
		}

		await this.metadataStore.save();
		return true;
	}

	private scanLocalFiles(): Map<string, TFile> {
		const configPrefix = `${this.configDir}/`;
		const files = new Map<string, TFile>();
		for (const file of this.vault.getFiles()) {
			if (
				file.path === this.configDir ||
				file.path.startsWith(configPrefix) ||
				file.path === '.trash' ||
				file.path.startsWith('.trash/')
			) {
				continue;
			}
			files.set(file.path, file);
		}
		return files;
	}

	private async pullCloudChanges(
		cloudIndex: Map<string, CloudObject>,
		localFiles: Map<string, TFile>,
		storage: S3StorageService,
		result: SyncResult,
	): Promise<void> {
		const database = this.metadataStore.database;
		const pendingPaths = new Set(database.pending_deletes);

		for (const [key, cloud] of cloudIndex) {
			// Local delete is in-flight: never resurrect the object from cloud.
			if (pendingPaths.has(key)) {
				continue;
			}

			try {
				validateVaultRelativePath(key, this.configDir);
				const record = database.files[key];
				const localFile = localFiles.get(key);

				if (!record) {
					const outcome = await this.applyCloudObject(
						key,
						cloud,
						localFile,
						storage,
						{ allowConflict: true },
					);
					if (outcome === 'pulled') {
						result.pulled += 1;
					} else if (outcome === 'conflict') {
						result.conflicts += 1;
					} else {
						result.skipped += 1;
					}
					continue;
				}

				if (!isCloudChanged(cloud, record)) {
					continue;
				}

				if (isLocalUnchanged(localFile, record)) {
					await this.downloadCloudFile(key, cloud, storage);
					result.pulled += 1;
					continue;
				}

				if (localFile) {
					const localContent = await this.vault.readBinary(localFile);
					const localMd5 = calculateMd5(localContent).hex;
					const cloudMd5 = etagToMd5(cloud.etag);

					// Content already matches cloud — only refresh metadata.
					if (cloudMd5 && localMd5 === cloudMd5) {
						database.files[key] = createFileRecord(
							localFile,
							localMd5,
						);
						result.metadataUpdated += 1;
						continue;
					}

					await this.resolveConflict(localFile, key, cloud, storage);
					result.conflicts += 1;
					continue;
				}

				// Local file missing but DB still has a record and cloud changed:
				// treat as cloud update (e.g. local delete not yet queued).
				await this.downloadCloudFile(key, cloud, storage);
				result.pulled += 1;
			} catch (error) {
				result.errors.push(`${key} pull: ${formatError(error)}`);
			}
		}

		for (const path of Object.keys(database.files)) {
			if (cloudIndex.has(path) || pendingPaths.has(path)) {
				continue;
			}

			const record = database.files[path];
			if (!record) {
				continue;
			}

			const localFile = localFiles.get(path);
			try {
				if (localFile && isLocalUnchanged(localFile, record)) {
					await this.vault.delete(localFile);
					delete database.files[path];
					result.localDeleted += 1;
					continue;
				}

				if (!localFile) {
					// Already gone locally and gone on cloud — drop the stale index.
					delete database.files[path];
					continue;
				}

				// Cloud deleted but local was modified: keep local so push can
				// re-upload it as a resurrection of the user's latest edit.
			} catch (error) {
				result.errors.push(
					`${path} local delete: ${formatError(error)}`,
				);
			}
		}
	}

	/**
	 * Apply a cloud object when there is no local DB record yet.
	 * Protects multi-device / first-run cases where the same path already exists locally.
	 */
	private async applyCloudObject(
		key: string,
		cloud: CloudObject,
		localFile: TFile | undefined,
		storage: S3StorageService,
		options: { allowConflict: boolean },
	): Promise<'pulled' | 'conflict' | 'indexed'> {
		if (!localFile) {
			await this.downloadCloudFile(key, cloud, storage);
			return 'pulled';
		}

		const localContent = await this.vault.readBinary(localFile);
		const localMd5 = calculateMd5(localContent).hex;
		const cloudMd5 = etagToMd5(cloud.etag);

		if (cloudMd5 && localMd5 === cloudMd5) {
			this.metadataStore.database.files[key] = createFileRecord(
				localFile,
				localMd5,
			);
			return 'indexed';
		}

		if (!options.allowConflict) {
			await this.downloadCloudFile(key, cloud, storage);
			return 'pulled';
		}

		await this.resolveConflict(localFile, key, cloud, storage);
		return 'conflict';
	}

	private async downloadCloudFile(
		key: string,
		cloud: CloudObject,
		storage: S3StorageService,
	): Promise<void> {
		const safeKey = validateVaultRelativePath(key, this.configDir);
		const content = await storage.download(key);
		const checksum = calculateMd5(content);
		const cloudMd5 = etagToMd5(cloud.etag) ?? checksum.hex;
		const existing = this.vault.getAbstractFileByPath(safeKey);

		if (existing instanceof TFile) {
			await this.vault.modifyBinary(existing, content);
		} else {
			await ensureParentFolders(this.vault, safeKey);
			await this.vault.createBinary(safeKey, content);
		}

		const savedFile = this.vault.getAbstractFileByPath(safeKey);
		if (!(savedFile instanceof TFile)) {
			throw new Error('Failed to save downloaded file locally.');
		}

		this.metadataStore.database.files[safeKey] = createFileRecord(
			savedFile,
			cloudMd5,
		);
	}

	private async resolveConflict(
		localFile: TFile,
		key: string,
		cloud: CloudObject,
		storage: S3StorageService,
	): Promise<void> {
		const conflictAt = new Date();
		const conflictPath = createConflictPath(key, conflictAt);
		await ensureParentFolders(this.vault, conflictPath);
		await this.app.fileManager.renameFile(localFile, conflictPath);

		const conflictFile = this.vault.getAbstractFileByPath(conflictPath);
		if (!(conflictFile instanceof TFile)) {
			throw new Error('Failed to create local conflict copy.');
		}

		const conflictContent = await this.vault.readBinary(conflictFile);
		const conflictChecksum = calculateMd5(conflictContent);
		this.metadataStore.database.files[conflictPath] = createFileRecord(
			conflictFile,
			conflictChecksum.hex,
		);
		delete this.metadataStore.database.files[key];

		await this.downloadCloudFile(key, cloud, storage);
	}

	private async reconcileDeleteQueue(
		localFiles: Map<string, TFile>,
	): Promise<void> {
		const database = this.metadataStore.database;

		database.pending_deletes = database.pending_deletes.filter(
			(path) => !localFiles.has(path),
		);

		const queuedPaths = new Set(database.pending_deletes);
		for (const path of Object.keys(database.files)) {
			if (localFiles.has(path) || queuedPaths.has(path)) {
				continue;
			}
			database.pending_deletes.push(path);
		}

		await this.metadataStore.save();
	}

	private async pushLocalChanges(
		localFiles: Map<string, TFile>,
		storage: S3StorageService,
		result: SyncResult,
	): Promise<void> {
		const records = this.metadataStore.database.files;
		const pendingPaths = new Set(
			this.metadataStore.database.pending_deletes,
		);

		for (const [path, file] of localFiles) {
			if (pendingPaths.has(path)) {
				continue;
			}

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
				result.errors.push(`${path} push: ${formatError(error)}`);
			}
		}
	}

	/**
	 * Copy-then-delete with circuit breaker: a failed CopyObject aborts all
	 * remaining delete work for this sync cycle — unless the source is already
	 * gone on the cloud (another device deleted it), which is treated as done.
	 */
	private async processPendingDeletes(
		storage: S3StorageService,
		result: SyncResult,
	): Promise<boolean> {
		const database = this.metadataStore.database;
		const pendingPaths = [...database.pending_deletes];

		for (const path of pendingPaths) {
			if (this.vault.getAbstractFileByPath(path)) {
				database.pending_deletes = database.pending_deletes.filter(
					(item) => item !== path,
				);
				await this.metadataStore.save();
				continue;
			}

			try {
				const wasteKey = createWasteKey(path, new Date());
				await storage.copyToWaste(path, wasteKey);
			} catch (error) {
				if (isMissingObjectError(error)) {
					delete database.files[path];
					database.pending_deletes = database.pending_deletes.filter(
						(item) => item !== path,
					);
					result.deleted += 1;
					await this.metadataStore.save();
					continue;
				}

				if (!database.pending_deletes.includes(path)) {
					database.pending_deletes.push(path);
				}
				result.errors.push(
					`${path} delete copy: ${formatError(error)}`,
				);
				await this.metadataStore.save();
				return false;
			}

			try {
				await storage.delete(path);
				delete database.files[path];
				database.pending_deletes = database.pending_deletes.filter(
					(item) => item !== path,
				);
				result.deleted += 1;
				await this.metadataStore.save();
			} catch (error) {
				if (isMissingObjectError(error)) {
					delete database.files[path];
					database.pending_deletes = database.pending_deletes.filter(
						(item) => item !== path,
					);
					result.deleted += 1;
					await this.metadataStore.save();
					continue;
				}

				if (!database.pending_deletes.includes(path)) {
					database.pending_deletes.push(path);
				}
				result.errors.push(
					`${path} delete object: ${formatError(error)}`,
				);
				await this.metadataStore.save();
				return false;
			}
		}

		return true;
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
	validateS3Endpoint(settings.endpoint);
}

function createSyncResult(): SyncResult {
	return {
		bootstrap: false,
		pulled: 0,
		conflicts: 0,
		localDeleted: 0,
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

function isLocalUnchanged(
	localFile: TFile | undefined,
	record: FileRecord,
): boolean {
	return Boolean(
		localFile &&
			localFile.stat.mtime === record.mtime &&
			localFile.stat.size === record.size,
	);
}

function isCloudChanged(cloud: CloudObject, record: FileRecord): boolean {
	const cloudMd5 = etagToMd5(cloud.etag);
	if (cloudMd5) {
		return cloudMd5 !== record.md5;
	}
	return cloud.size !== record.size;
}

function isMissingObjectError(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const awsError = error as Error & {
		name?: string;
		Code?: string;
		code?: string;
		$metadata?: { httpStatusCode?: number };
	};
	const code = String(
		awsError.Code ?? awsError.code ?? awsError.name ?? '',
	).toLowerCase();
	if (
		code.includes('nosuchkey') ||
		code.includes('notfound') ||
		code === '404'
	) {
		return true;
	}
	return awsError.$metadata?.httpStatusCode === 404;
}

async function ensureParentFolders(vault: Vault, path: string): Promise<void> {
	const parts = path.split('/').filter(Boolean);
	parts.pop();
	let current = '';
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		if (!vault.getAbstractFileByPath(current)) {
			await vault.createFolder(current);
		}
	}
}

function formatError(error: unknown): string {
	return formatS3Error(error);
}
