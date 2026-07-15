export const MIN_SYNC_INTERVAL_SECONDS = 20;
export const DEFAULT_BACKUP_EXPORT_PATH = 'Backup_Export/';

export interface S3BackupSettings {
	endpoint: string;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	syncIntervalSeconds: number;
	backupExportPath: string;
}

export const DEFAULT_SETTINGS: S3BackupSettings = {
	endpoint: '',
	region: 'auto',
	bucket: '',
	accessKeyId: '',
	secretAccessKey: '',
	syncIntervalSeconds: MIN_SYNC_INTERVAL_SECONDS,
	backupExportPath: DEFAULT_BACKUP_EXPORT_PATH,
};

const CLIPBOARD_CONFIG_KEYS = new Set([
	'endpoint',
	'region',
	'bucket',
	'accessKeyId',
	'secretAccessKey',
	'syncIntervalSeconds',
]);

const CLIPBOARD_CONFIG_REGEX =
	/(endpoint|region|bucket|accessKeyId|secretAccessKey|syncIntervalSeconds)=['"]?(.*?)['"]?(&|$)/g;

export function parseClipboardConfig(
	text: string,
): Partial<S3BackupSettings> {
	const result: Partial<S3BackupSettings> = {};

	for (const match of text.matchAll(CLIPBOARD_CONFIG_REGEX)) {
		const key = match[1];
		if (!key || !CLIPBOARD_CONFIG_KEYS.has(key)) {
			continue;
		}

		const rawValue = decodeClipboardValue(match[2] ?? '');

		if (key === 'syncIntervalSeconds') {
			const parsed = Number.parseInt(rawValue, 10);
			if (!Number.isNaN(parsed)) {
				result.syncIntervalSeconds = Math.max(
					MIN_SYNC_INTERVAL_SECONDS,
					parsed,
				);
			}
			continue;
		}

		result[key as Exclude<keyof S3BackupSettings, 'syncIntervalSeconds'>] =
			rawValue;
	}

	return result;
}

export function formatClipboardConfig(settings: S3BackupSettings): string {
	const pairs: Array<[keyof S3BackupSettings, string]> = [
		['endpoint', settings.endpoint],
		['region', settings.region],
		['bucket', settings.bucket],
		['accessKeyId', settings.accessKeyId],
		['secretAccessKey', settings.secretAccessKey],
		['syncIntervalSeconds', String(settings.syncIntervalSeconds)],
	];
	return pairs
		.map(([key, value]) => `${key}='${escapeClipboardValue(value ?? '')}'`)
		.join('&');
}

export function clampSyncInterval(seconds: number): number {
	if (Number.isNaN(seconds)) {
		return MIN_SYNC_INTERVAL_SECONDS;
	}
	return Math.max(MIN_SYNC_INTERVAL_SECONDS, Math.floor(seconds));
}

function decodeClipboardValue(value: string): string {
	const trimmed = value.trim();
	const unquoted =
		(trimmed.startsWith("'") && trimmed.endsWith("'")) ||
		(trimmed.startsWith('"') && trimmed.endsWith('"'))
			? trimmed.slice(1, -1)
			: trimmed;
	return unquoted.trim();
}

function escapeClipboardValue(value: string): string {
	return value.replace(/'/g, "\\'");
}
