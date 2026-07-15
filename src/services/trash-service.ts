import type { App, Vault } from 'obsidian';
import {
	joinSafeVaultPath,
	validateVaultRelativePath,
} from '../security/validation';
import {
	DEFAULT_BACKUP_EXPORT_PATH,
	type S3BackupSettings,
} from '../settings';
import { formatS3Error } from '../s3/client';
import { S3StorageService } from '../s3/storage-service';
import {
	buildTrashTree,
	createPickupKey,
	parseWasteKey,
	type TrashFolderNode,
	type TrashItem,
} from './trash-tree';

export class TrashService {
	constructor(
		private readonly app: App,
		private readonly vault: Vault,
		private readonly configDir: string,
		private readonly getSettings: () => S3BackupSettings,
	) {}

	async listTrashItems(): Promise<TrashItem[]> {
		const storage = this.createStorage();
		try {
			const objects = await storage.listObjectsByPrefix('.wastePaper/');
			return objects
				.map((object) => parseWasteKey(object.key))
				.filter((item): item is TrashItem => item !== null);
		} finally {
			storage.destroy();
		}
	}

	async listTrashTree(): Promise<TrashFolderNode> {
		const items = await this.listTrashItems();
		return buildTrashTree(items);
	}

	/**
	 * Restore transaction with circuit breaker:
	 * 1. Download to local restore folder
	 * 2. Copy waste object to .pickUpPaper/
	 * 3. Delete the original waste object
	 * Any step failure aborts the remaining steps.
	 */
	async restoreItem(item: TrashItem): Promise<string> {
		const settings = this.getSettings();
		const storage = this.createStorage();

		try {
			let content: ArrayBuffer;
			try {
				content = await storage.download(item.key);
			} catch (error) {
				throw new Error(
					`Download failed: ${formatS3Error(error)}`,
				);
			}

			const restoreBase = getRestoreBasePath(settings.backupExportPath);
			const targetPath = joinSafeVaultPath(
				restoreBase,
				item.originalPath,
				this.configDir,
			);
			const uniquePath = resolveUniquePath(this.vault, targetPath);

			try {
				await ensureParentFolders(this.vault, uniquePath);
				await this.vault.createBinary(uniquePath, content);
			} catch (error) {
				throw new Error(
					`Save locally failed: ${formatS3Error(error)}`,
				);
			}

			const pickupKey = createPickupKey(item.originalPath, new Date());
			try {
				await storage.copyObject(item.key, pickupKey);
			} catch (error) {
				const rolledBack = await this.rollbackLocalRestore(uniquePath);
				throw new Error(
					`Audit copy to .pickUpPaper/ failed: ${formatS3Error(error)}` +
						(rolledBack ? '' : ' Local rollback also failed.'),
				);
			}

			try {
				await storage.delete(item.key);
			} catch (error) {
				const rolledBack = await this.rollbackLocalRestore(uniquePath);
				throw new Error(
					`Delete from .wastePaper/ failed; the audit copy was retained: ` +
						formatS3Error(error) +
						(rolledBack ? '' : ' Local rollback also failed.'),
				);
			}

			return uniquePath;
		} finally {
			storage.destroy();
		}
	}

	private createStorage(): S3StorageService {
		return new S3StorageService(this.getSettings());
	}

	private async rollbackLocalRestore(path: string): Promise<boolean> {
		try {
			const restoredFile = this.vault.getAbstractFileByPath(path);
			if (restoredFile) {
				await this.app.fileManager.trashFile(restoredFile);
			}
			return true;
		} catch {
			return false;
		}
	}
}

export function getRestoreBasePath(backupExportPath: string): string {
	const normalized = backupExportPath.trim();
	if (
		!normalized ||
		normalized === DEFAULT_BACKUP_EXPORT_PATH ||
		normalized === 'Backup_Export'
	) {
		return '已恢复/';
	}
	return `${validateVaultRelativePath(normalized)}/`;
}

export function resolveUniquePath(vault: Vault, targetPath: string): string {
	if (!vault.getAbstractFileByPath(targetPath)) {
		return targetPath;
	}

	const separatorIndex = targetPath.lastIndexOf('/');
	const directory =
		separatorIndex >= 0 ? `${targetPath.slice(0, separatorIndex + 1)}` : '';
	const filename =
		separatorIndex >= 0 ? targetPath.slice(separatorIndex + 1) : targetPath;
	const dotIndex = filename.lastIndexOf('.');
	const stem = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
	const extension = dotIndex > 0 ? filename.slice(dotIndex) : '';

	let index = 1;
	while (true) {
		const candidate = `${directory}${stem}_${index}${extension}`;
		if (!vault.getAbstractFileByPath(candidate)) {
			return candidate;
		}
		index += 1;
	}
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
