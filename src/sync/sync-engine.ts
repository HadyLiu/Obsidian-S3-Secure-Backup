import { type App, Platform, TFile, type Vault } from 'obsidian';
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
import {
	detectSanitizedPathCollisions,
	WindowsPathCollisionError,
	WindowsPathCollisionTracker,
} from './path-collision-tracker';
import {
	ensureParentFolders,
	resolveVaultFile,
	toLocalVaultPath,
	writeVaultBinary,
} from './vault-paths';

export interface SyncResult {
	bootstrap: boolean;
	pulled: number;
	conflicts: number;
	pathCollisions: number;
	localDeleted: number;
	uploaded: number;
	metadataUpdated: number;
	deleted: number;
	skipped: number;
	pendingDeletes: number;
	warnings: string[];
	errors: string[];
}

export class SyncEngine {
	private running = false;
	private pathCollisionTracker: WindowsPathCollisionTracker | null = null;

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
		this.pathCollisionTracker = new WindowsPathCollisionTracker(
			this.metadataStore.database.files,
		);

		try {
			const bootstrapped = await this.runBootstrapIfNeeded(storage, result);
			if (bootstrapped) {
				this.mergePathCollisionWarnings(result);
				// First voyage still needs to publish local-only files; otherwise
				// an empty cloud + empty index would loop forever without PutObject.
				await this.pushLocalChanges(
					this.scanLocalFiles(),
					storage,
					result,
				);

				if (result.errors.length === 0) {
					this.metadataStore.database.last_sync_time = Date.now();
				}

				await this.metadataStore.save();
				result.pendingDeletes =
					this.metadataStore.database.pending_deletes.length;
				return result;
			}

			const localFiles = this.scanLocalFiles();
			const cloudObjects = await storage.listVaultObjects();
			this.scanCloudPathCollisions(
				cloudObjects.map((object) => object.key),
				result,
			);
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
			this.pathCollisionTracker = null;
			storage.destroy();
			this.running = false;
		}
	}

	private scanCloudPathCollisions(
		cloudKeys: string[],
		result: SyncResult,
	): void {
		if (!this.pathCollisionTracker) {
			return;
		}

		this.pathCollisionTracker.reportBatchCollisions(
			detectSanitizedPathCollisions(cloudKeys),
		);
		this.mergePathCollisionWarnings(result);
	}

	private mergePathCollisionWarnings(result: SyncResult): void {
		if (!this.pathCollisionTracker) {
			return;
		}

		for (const warning of this.pathCollisionTracker.warnings) {
			if (!result.warnings.includes(warning)) {
				result.warnings.push(warning);
			}
		}
	}

	private handleSyncError(
		error: unknown,
		context: string,
		result: SyncResult,
	): void {
		if (error instanceof WindowsPathCollisionError) {
			result.pathCollisions += 1;
			if (!result.warnings.includes(error.message)) {
				result.warnings.push(error.message);
			}
			return;
		}

		result.errors.push(`${context}: ${formatError(error)}`);
	}

	/**
	 * First voyage only: never completed a successful sync yet.
	 * Do NOT use empty `files` alone — an empty cloud leaves the index empty and
	 * would permanently skip Push.
	 */
	private needsBootstrap(): boolean {
		return this.metadataStore.database.last_sync_time === 0;
	}

	/**
	 * First-run full pull: download every cloud object with conflict protection
	 * and rebuild the local index. Caller then pushes local-only files.
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
		this.scanCloudPathCollisions(
			cloudObjects.map((object) => object.key),
			result,
		);
		const localFiles = this.scanLocalFiles();

		for (const cloud of cloudObjects) {
			if (this.pathCollisionTracker?.isCloudKeyBlocked(cloud.key)) {
				result.pathCollisions += 1;
				continue;
			}

			try {
				validateVaultRelativePath(cloud.key, this.configDir);
				const localPath = toLocalVaultPath(cloud.key);
				const outcome = await this.applyCloudObject(
					cloud.key,
					cloud,
					localFiles.get(localPath),
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
				this.handleSyncError(error, `${cloud.key} bootstrap`, result);
			}
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

			if (this.pathCollisionTracker?.isCloudKeyBlocked(key)) {
				result.pathCollisions += 1;
				continue;
			}

			try {
				validateVaultRelativePath(key, this.configDir);
				const record = database.files[key];
				const localPath = record?.path ?? toLocalVaultPath(key);
				const localFile = localFiles.get(localPath);

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
				this.handleSyncError(error, `${key} pull`, result);
			}
		}

		for (const cloudKey of Object.keys(database.files)) {
			if (cloudIndex.has(cloudKey) || pendingPaths.has(cloudKey)) {
				continue;
			}

			const record = database.files[cloudKey];
			if (!record) {
				continue;
			}

			const localFile = localFiles.get(record.path);
			try {
				if (localFile && isLocalUnchanged(localFile, record)) {
					await this.vault.delete(localFile);
					delete database.files[cloudKey];
					result.localDeleted += 1;
					continue;
				}

				if (!localFile) {
					// Already gone locally and gone on cloud — drop the stale index.
					delete database.files[cloudKey];
					continue;
				}

				// Cloud deleted but local was modified: keep local so push can
				// re-upload it as a resurrection of the user's latest edit.
			} catch (error) {
				result.errors.push(
					`${cloudKey} local delete: ${formatError(error)}`,
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
		let cloudMd5 = etagToMd5(cloud.etag);

		// Multipart ETags are not MD5 — fetch once and hash the body.
		if (!cloudMd5) {
			const remoteContent = await storage.download(key);
			cloudMd5 = calculateMd5(remoteContent).hex;
			if (localMd5 === cloudMd5) {
				this.metadataStore.database.files[key] = createFileRecord(
					localFile,
					localMd5,
				);
				return 'indexed';
			}

			if (!options.allowConflict) {
				await this.writeLocalFile(key, remoteContent, cloudMd5);
				return 'pulled';
			}

			await this.resolveConflictWithContent(
				localFile,
				key,
				remoteContent,
				cloudMd5,
			);
			return 'conflict';
		}

		if (localMd5 === cloudMd5) {
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
		const content = await storage.download(key);
		const checksum = calculateMd5(content);
		const cloudMd5 = etagToMd5(cloud.etag) ?? checksum.hex;
		await this.writeLocalFile(key, content, cloudMd5);
	}

	private async writeLocalFile(
		cloudKey: string,
		content: ArrayBuffer,
		md5: string,
	): Promise<void> {
		const safeCloudKey = validateVaultRelativePath(cloudKey, this.configDir);
		const localPath = toLocalVaultPath(safeCloudKey);
		this.pathCollisionTracker?.assertWritable(safeCloudKey, localPath);
		const savedFile = await writeVaultBinary(
			this.vault,
			localPath,
			content,
		);

		this.metadataStore.database.files[safeCloudKey] = createFileRecord(
			savedFile,
			md5,
		);
	}

	private async resolveConflict(
		localFile: TFile,
		key: string,
		cloud: CloudObject,
		storage: S3StorageService,
	): Promise<void> {
		const content = await storage.download(key);
		const checksum = calculateMd5(content);
		const cloudMd5 = etagToMd5(cloud.etag) ?? checksum.hex;
		await this.resolveConflictWithContent(
			localFile,
			key,
			content,
			cloudMd5,
		);
	}

	private async resolveConflictWithContent(
		localFile: TFile,
		cloudKey: string,
		cloudContent: ArrayBuffer,
		cloudMd5: string,
	): Promise<void> {
		const conflictAt = new Date();
		const conflictPath = createConflictPath(localFile.path, conflictAt);
		await ensureParentFolders(this.vault, conflictPath);
		await this.app.fileManager.renameFile(localFile, conflictPath);

		const conflictFile = resolveVaultFile(this.vault, conflictPath);
		if (!conflictFile) {
			throw new Error('Failed to create local conflict copy.');
		}

		const conflictContent = await this.vault.readBinary(conflictFile);
		const conflictChecksum = calculateMd5(conflictContent);
		this.metadataStore.database.files[conflictPath] = createFileRecord(
			conflictFile,
			conflictChecksum.hex,
		);
		delete this.metadataStore.database.files[cloudKey];

		await this.writeLocalFile(cloudKey, cloudContent, cloudMd5);
	}

	private async reconcileDeleteQueue(
		localFiles: Map<string, TFile>,
	): Promise<void> {
		const database = this.metadataStore.database;

		database.pending_deletes = database.pending_deletes.filter(
			(cloudKey) => {
				const record = database.files[cloudKey];
				const localPath = record?.path ?? toLocalVaultPath(cloudKey);
				return !localFiles.has(localPath);
			},
		);

		const queuedPaths = new Set(database.pending_deletes);
		for (const [cloudKey, record] of Object.entries(database.files)) {
			if (localFiles.has(record.path) || queuedPaths.has(cloudKey)) {
				continue;
			}
			database.pending_deletes.push(cloudKey);
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
		const localToCloudKey = buildLocalToCloudKeyMap(records);

		for (const [localPath, file] of localFiles) {
			const cloudKey = localToCloudKey.get(localPath) ?? localPath;
			if (pendingPaths.has(cloudKey)) {
				continue;
			}

			const previous = records[cloudKey];
			if (
				previous &&
				previous.size === file.stat.size &&
				isCloseMtime(previous.mtime, file.stat.mtime)
			) {
				result.skipped += 1;
				continue;
			}

			try {
				const content = await this.vault.readBinary(file);
				const checksum = calculateMd5(content);

				if (previous?.md5 === checksum.hex) {
					records[cloudKey] = createFileRecord(file, checksum.hex);
					result.metadataUpdated += 1;
					continue;
				}

				await storage.upload(cloudKey, content, checksum.base64);
				records[cloudKey] = createFileRecord(file, checksum.hex);
				result.uploaded += 1;
			} catch (error) {
				result.errors.push(`${cloudKey} push: ${formatError(error)}`);
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

		for (const cloudKey of pendingPaths) {
			const record = database.files[cloudKey];
			const localPath = record?.path ?? toLocalVaultPath(cloudKey);
			if (this.vault.getAbstractFileByPath(localPath)) {
				database.pending_deletes = database.pending_deletes.filter(
					(item) => item !== cloudKey,
				);
				await this.metadataStore.save();
				continue;
			}

			try {
				const wasteKey = createWasteKey(cloudKey, new Date());
				await storage.copyToWaste(cloudKey, wasteKey);
			} catch (error) {
				if (isMissingObjectError(error)) {
					delete database.files[cloudKey];
					database.pending_deletes = database.pending_deletes.filter(
						(item) => item !== cloudKey,
					);
					result.deleted += 1;
					await this.metadataStore.save();
					continue;
				}

				if (!database.pending_deletes.includes(cloudKey)) {
					database.pending_deletes.push(cloudKey);
				}
				result.errors.push(
					`${cloudKey} delete copy: ${formatError(error)}`,
				);
				await this.metadataStore.save();
				return false;
			}

			try {
				await storage.delete(cloudKey);
				delete database.files[cloudKey];
				database.pending_deletes = database.pending_deletes.filter(
					(item) => item !== cloudKey,
				);
				result.deleted += 1;
				await this.metadataStore.save();
			} catch (error) {
				if (isMissingObjectError(error)) {
					delete database.files[cloudKey];
					database.pending_deletes = database.pending_deletes.filter(
						(item) => item !== cloudKey,
					);
					result.deleted += 1;
					await this.metadataStore.save();
					continue;
				}

				if (!database.pending_deletes.includes(cloudKey)) {
					database.pending_deletes.push(cloudKey);
				}
				result.errors.push(
					`${cloudKey} delete object: ${formatError(error)}`,
				);
				await this.metadataStore.save();
				return false;
			}
		}

		return true;
	}
}

function buildLocalToCloudKeyMap(
	files: Record<string, FileRecord>,
): Map<string, string> {
	const map = new Map<string, string>();
	for (const [cloudKey, record] of Object.entries(files)) {
		map.set(record.path, cloudKey);
	}
	return map;
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
		pathCollisions: 0,
		localDeleted: 0,
		uploaded: 0,
		metadataUpdated: 0,
		deleted: 0,
		skipped: 0,
		pendingDeletes: 0,
		warnings: [],
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

function isCloseMtime(left: number, right: number): boolean {
	if (left === right) {
		return true;
	}
	return Platform.isWin && Math.abs(left - right) <= 1000;
}

function isLocalUnchanged(
	localFile: TFile | undefined,
	record: FileRecord,
): boolean {
	if (!localFile || localFile.stat.size !== record.size) {
		return false;
	}

	if (localFile.stat.mtime === record.mtime) {
		return true;
	}

	return isCloseMtime(localFile.stat.mtime, record.mtime);
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

function formatError(error: unknown): string {
	return formatS3Error(error);
}
