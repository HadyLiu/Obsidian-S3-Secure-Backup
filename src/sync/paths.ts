const SYSTEM_PREFIXES = ['.wastePaper/', '.pickUpPaper/', '.Backup/'];

export function isSystemObjectKey(key: string): boolean {
	return SYSTEM_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function createWasteKey(path: string, deletedAt: Date): string {
	const separatorIndex = path.lastIndexOf('/');
	const directory =
		separatorIndex >= 0 ? `${path.slice(0, separatorIndex + 1)}` : '';
	const filename =
		separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
	return `.wastePaper/${directory}${formatTimestamp(deletedAt)}_${filename}`;
}

export function createConflictPath(path: string, conflictAt: Date): string {
	const separatorIndex = path.lastIndexOf('/');
	const directory =
		separatorIndex >= 0 ? `${path.slice(0, separatorIndex + 1)}` : '';
	const filename =
		separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
	const dotIndex = filename.lastIndexOf('.');
	const stem = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
	const extension = dotIndex > 0 ? filename.slice(dotIndex) : '';
	return `${directory}${stem}_conflict_${formatTimestamp(conflictAt)}${extension}`;
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
