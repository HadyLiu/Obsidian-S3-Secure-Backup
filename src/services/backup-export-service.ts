import type { App, Vault } from 'obsidian';
import JSZip from 'jszip';
import {
	joinSafeVaultPath,
	validateVaultRelativePath,
} from '../security/validation';
import type { S3BackupSettings } from '../settings';
import { formatS3Error } from '../s3/client';
import { S3StorageService } from '../s3/storage-service';

export interface BackupPackage {
	dateKey: string;
	displayDate: string;
	prefix: string;
	objectCount: number;
}

export interface ExportProgress {
	completed: number;
	total: number;
	currentFile: string;
}

export class BackupExportService {
	constructor(
		private readonly app: App,
		private readonly vault: Vault,
		private readonly getSettings: () => S3BackupSettings,
	) {}

	async listRecentPackages(days = 7): Promise<BackupPackage[]> {
		const settings = this.getSettings();
		const bucket = settings.bucket.trim();
		const backupRoot = `.Backup/${bucket}/`;
		const storage = this.createStorage();

		try {
			const objects = await storage.listObjectsByPrefix(backupRoot);
			const counts = new Map<string, number>();

			for (const object of objects) {
				const relative = object.key.slice(backupRoot.length);
				const match = relative.match(/^(\d{8})_backup\//);
				if (!match?.[1]) {
					continue;
				}
				const dateKey = match[1];
				counts.set(dateKey, (counts.get(dateKey) ?? 0) + 1);
			}

			const packages: BackupPackage[] = [];
			for (let offset = 0; offset < days; offset += 1) {
				const date = shiftDays(new Date(), -offset);
				const dateKey = formatDateKey(date);
				const prefix = `${backupRoot}${dateKey}_backup/`;
				packages.push({
					dateKey,
					displayDate: formatDisplayDate(date),
					prefix,
					objectCount: counts.get(dateKey) ?? 0,
				});
			}

			return packages;
		} finally {
			storage.destroy();
		}
	}

	async exportPackages(
		selectedDateKeys: string[],
		exportBasePath: string,
		onProgress?: (progress: ExportProgress) => void,
	): Promise<string> {
		if (selectedDateKeys.length === 0) {
			throw new Error('Select at least one backup date.');
		}

		const settings = this.getSettings();
		const bucket = settings.bucket.trim();
		const storage = this.createStorage();
		const zip = new JSZip();

		try {
			const files: Array<{ zipPath: string; key: string }> = [];
			for (const dateKey of selectedDateKeys) {
				if (!/^\d{8}$/.test(dateKey)) {
					throw new Error('Invalid backup date identifier.');
				}
				const prefix = `.Backup/${bucket}/${dateKey}_backup/`;
				const objects = await storage.listObjectsByPrefix(prefix);
				for (const object of objects) {
					const relativePath = object.key.slice(prefix.length);
					if (!relativePath) {
						continue;
					}
					const safeRelativePath =
						validateVaultRelativePath(relativePath);
					files.push({
						zipPath: `${dateKey}/${safeRelativePath}`,
						key: object.key,
					});
				}
			}

			if (files.length === 0) {
				throw new Error('No backup files found for the selected dates.');
			}

			let completed = 0;
			for (const file of files) {
				onProgress?.({
					completed,
					total: files.length,
					currentFile: file.zipPath,
				});
				const content = await storage.download(file.key);
				zip.file(file.zipPath, content);
				completed += 1;
			}

			onProgress?.({
				completed: files.length,
				total: files.length,
				currentFile: 'Generating zip...',
			});

			const zipBuffer = await zip.generateAsync({ type: 'arraybuffer' });
			const outputPath = joinSafeVaultPath(
				exportBasePath,
				`s3-backup-${selectedDateKeys.join('-')}.zip`,
				this.vault.configDir,
			);
			await this.writeExportFile(outputPath, zipBuffer);
			return outputPath;
		} catch (error) {
			throw new Error(formatS3Error(error));
		} finally {
			storage.destroy();
		}
	}

	private async writeExportFile(
		path: string,
		content: ArrayBuffer,
	): Promise<void> {
		await ensureParentFolders(this.vault, path);
		const existing = this.vault.getAbstractFileByPath(path);
		if (existing) {
			await this.app.fileManager.trashFile(existing);
		}
		await this.vault.createBinary(path, content);
	}

	private createStorage(): S3StorageService {
		return new S3StorageService(this.getSettings());
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

function shiftDays(date: Date, days: number): Date {
	const copy = new Date(date);
	copy.setDate(copy.getDate() + days);
	return copy;
}

function formatDateKey(date: Date): string {
	const year = String(date.getFullYear());
	const month = padTwoDigits(date.getMonth() + 1);
	const day = padTwoDigits(date.getDate());
	return `${year}${month}${day}`;
}

function formatDisplayDate(date: Date): string {
	const year = String(date.getFullYear());
	const month = padTwoDigits(date.getMonth() + 1);
	const day = padTwoDigits(date.getDate());
	return `${year}-${month}-${day}`;
}

function padTwoDigits(value: number): string {
	return String(value).padStart(2, '0');
}
