import { TFile, type Vault } from 'obsidian';
import type { FileRecord, MetadataStore } from '../database/metadata-store';
import type { S3BackupSettings } from '../settings';
import { formatS3Error } from '../s3/client';
import { S3StorageService } from '../s3/storage-service';
import { calculateMd5 } from '../sync/checksum';

const DAY_MS = 86_400_000;

export interface BackupResult {
	backedUp: number;
	skipped: number;
	errors: string[];
}

export class BackupEngine {
	private running = false;

	constructor(
		private readonly vault: Vault,
		private readonly metadataStore: MetadataStore,
		private readonly getSettings: () => S3BackupSettings,
	) {}

	get isRunning(): boolean {
		return this.running;
	}

	isDue(): boolean {
		const lastBackupTime = this.metadataStore.database.last_backup_time;
		return Date.now() - lastBackupTime >= DAY_MS;
	}

	async runIfDue(): Promise<BackupResult | null> {
		if (!this.isDue()) {
			return null;
		}
		return this.run();
	}

	async run(): Promise<BackupResult> {
		if (this.running) {
			throw new Error('A daily backup is already running.');
		}

		const settings = this.getSettings();
		validateSettings(settings);
		this.running = true;
		const storage = new S3StorageService(settings);
		const result = createBackupResult();
		const backupDate = formatBackupDate(new Date());
		const backupPrefix = `.Backup/${settings.bucket.trim()}/${backupDate}_backup`;

		try {
			const diffFiles = selectDiffFiles(this.metadataStore.database.files);
			for (const record of diffFiles) {
				const localFile = this.vault.getAbstractFileByPath(record.path);
				if (!(localFile instanceof TFile)) {
					result.skipped += 1;
					continue;
				}

				try {
					const content = await this.vault.readBinary(localFile);
					const checksum = calculateMd5(content);
					const backupKey = `${backupPrefix}/${record.path}`;
					await storage.upload(backupKey, content, checksum.base64);
					result.backedUp += 1;
				} catch (error) {
					result.errors.push(
						`${record.path}: ${formatS3Error(error)}`,
					);
				}
			}

			if (result.errors.length === 0) {
				this.metadataStore.database.last_backup_time = Date.now();
			}
			await this.metadataStore.save();
			return result;
		} finally {
			storage.destroy();
			this.running = false;
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
		throw new Error('Complete the S3 connection settings before backing up.');
	}
}

function selectDiffFiles(
	files: Record<string, FileRecord>,
): FileRecord[] {
	const cutoff = Date.now() - DAY_MS;
	return Object.values(files).filter((record) => record.mtime >= cutoff);
}

function formatBackupDate(date: Date): string {
	const year = String(date.getFullYear());
	const month = padTwoDigits(date.getMonth() + 1);
	const day = padTwoDigits(date.getDate());
	return `${year}${month}${day}`;
}

function padTwoDigits(value: number): string {
	return String(value).padStart(2, '0');
}

function createBackupResult(): BackupResult {
	return {
		backedUp: 0,
		skipped: 0,
		errors: [],
	};
}
