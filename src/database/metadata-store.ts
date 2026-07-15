import type { DataAdapter } from 'obsidian';
import { normalizePath } from 'obsidian';

const DATABASE_VERSION = 1;

export interface FileRecord {
	path: string;
	mtime: number;
	size: number;
	md5: string;
}

export interface PendingDelete {
	path: string;
	wasteKey: string;
	deletedAt: number;
	copyCompleted: boolean;
	lastError?: string;
}

export interface MetadataDatabase {
	version: number;
	files: Record<string, FileRecord>;
	pending_deletes: PendingDelete[];
	last_backup_time: number;
}

function createEmptyDatabase(): MetadataDatabase {
	return {
		version: DATABASE_VERSION,
		files: {},
		pending_deletes: [],
		last_backup_time: 0,
	};
}

export class MetadataStore {
	private readonly directoryPath: string;
	private readonly filePath: string;
	private data: MetadataDatabase = createEmptyDatabase();

	constructor(
		private readonly adapter: DataAdapter,
		configDir: string,
		pluginId: string,
	) {
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
			files: parsed.files ?? {},
			pending_deletes: parsed.pending_deletes ?? [],
			last_backup_time: parsed.last_backup_time ?? 0,
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
