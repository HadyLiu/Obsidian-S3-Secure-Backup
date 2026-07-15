import type { DataAdapter } from 'obsidian';
import { normalizePath } from 'obsidian';
import { validateVaultRelativePath } from '../security/validation';

const DATABASE_VERSION = 2;

export interface FileRecord {
	path: string;
	mtime: number;
	size: number;
	md5: string;
}

export interface MetadataDatabase {
	version: number;
	last_sync_time: number;
	last_backup_time: number;
	files: Record<string, FileRecord>;
	pending_deletes: string[];
}

function createEmptyDatabase(): MetadataDatabase {
	return {
		version: DATABASE_VERSION,
		last_sync_time: 0,
		last_backup_time: 0,
		files: {},
		pending_deletes: [],
	};
}

function normalizePendingDeletes(raw: unknown, configDir: string): string[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw
		.map((item) => {
			if (typeof item === 'string') {
				return item;
			}
			if (
				typeof item === 'object' &&
				item !== null &&
				'path' in item &&
				typeof (item as { path: unknown }).path === 'string'
			) {
				return (item as { path: string }).path;
			}
			return null;
		})
		.filter((path): path is string => Boolean(path))
		.filter((path) => isSafeMetadataPath(path, configDir));
}

export class MetadataStore {
	private readonly directoryPath: string;
	private readonly filePath: string;
	private readonly configDir: string;
	private data: MetadataDatabase = createEmptyDatabase();

	constructor(
		private readonly adapter: DataAdapter,
		configDir: string,
		pluginId: string,
	) {
		this.configDir = configDir;
		this.directoryPath = normalizePath(
			`${configDir}/plugins/${pluginId}/.Database`,
		);
		this.filePath = normalizePath(
			`${this.directoryPath}/local-metadata.json`,
		);
	}

	get database(): MetadataDatabase {
		return this.data;
	}

	async load(): Promise<void> {
		await this.ensureDirectory();
		if (!(await this.adapter.exists(this.filePath))) {
			this.data = createEmptyDatabase();
			await this.save();
			return;
		}

		const raw = await this.adapter.read(this.filePath);
		const parsed = JSON.parse(raw) as Partial<MetadataDatabase>;
		this.data = {
			version: DATABASE_VERSION,
			last_sync_time: parsed.last_sync_time ?? 0,
			last_backup_time: parsed.last_backup_time ?? 0,
			files: normalizeFileRecords(parsed.files, this.configDir),
			pending_deletes: normalizePendingDeletes(
				parsed.pending_deletes,
				this.configDir,
			),
		};
	}

	async save(): Promise<void> {
		await this.ensureDirectory();
		const orderedFiles = Object.fromEntries(
			Object.entries(this.data.files).sort(([left], [right]) =>
				left.localeCompare(right),
			),
		);
		const serialized: MetadataDatabase = {
			...this.data,
			files: orderedFiles,
		};
		await this.adapter.write(
			this.filePath,
			`${JSON.stringify(serialized, null, 2)}\n`,
		);
	}

	private async ensureDirectory(): Promise<void> {
		if (!(await this.adapter.exists(this.directoryPath))) {
			await this.adapter.mkdir(this.directoryPath);
		}
	}
}

function normalizeFileRecords(
	raw: unknown,
	configDir: string,
): Record<string, FileRecord> {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return {};
	}

	const files: Record<string, FileRecord> = {};
	for (const [path, value] of Object.entries(raw)) {
		if (
			!isSafeMetadataPath(path, configDir) ||
			!value ||
			typeof value !== 'object'
		) {
			continue;
		}
		const record = value as Partial<FileRecord>;
		if (
			typeof record.mtime !== 'number' ||
			typeof record.size !== 'number' ||
			typeof record.md5 !== 'string'
		) {
			continue;
		}
		files[path] = { path, mtime: record.mtime, size: record.size, md5: record.md5 };
	}
	return files;
}

function isSafeMetadataPath(path: string, configDir: string): boolean {
	try {
		validateVaultRelativePath(path, configDir);
		return true;
	} catch {
		return false;
	}
}
