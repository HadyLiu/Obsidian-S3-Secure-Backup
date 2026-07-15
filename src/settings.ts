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

const CLIPBOARD_CONFIG_REGEX =
	/(endpoint|region|bucket|accessKeyId|secretAccessKey|syncIntervalSeconds)=['"]?(.*?)['"]?(&|$)/g;

const CLIPBOARD_CONFIG_KEYS = new Set([
	'endpoint',
	'region',
	'bucket',
	'accessKeyId',
	'secretAccessKey',
	'syncIntervalSeconds',
]);

export function parseClipboardConfig(
	text: string,
): Partial<S3BackupSettings> {
	const result: Partial<S3BackupSettings> = {};
	const regex = new RegExp(CLIPBOARD_CONFIG_REGEX.source, 'g');
	let match: RegExpExecArray | null;

	while ((match = regex.exec(text)) !== null) {
		const key = match[1];
		const rawValue = match[2]?.trim() ?? '';
		if (!key || !CLIPBOARD_CONFIG_KEYS.has(key)) {
			continue;
		}

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
	const pairs = [
		`endpoint='${settings.endpoint}'`,
		`region='${settings.region}'`,
		`bucket='${settings.bucket}'`,
		`accessKeyId='${settings.accessKeyId}'`,
		`secretAccessKey='${settings.secretAccessKey}'`,
		`syncIntervalSeconds='${settings.syncIntervalSeconds}'`,
	];
	return pairs.join('&');
}

export function clampSyncInterval(seconds: number): number {
	if (Number.isNaN(seconds)) {
		return MIN_SYNC_INTERVAL_SECONDS;
	}
	return Math.max(MIN_SYNC_INTERVAL_SECONDS, Math.floor(seconds));
}
