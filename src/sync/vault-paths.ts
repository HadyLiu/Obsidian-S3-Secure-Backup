import { normalizePath, Platform, TFile, type Vault } from 'obsidian';

const WINDOWS_INVALID_CHARS = /[<>:"|?*]/g;
const WINDOWS_RESERVED_NAME =
	/^(con|prn|aux|nul|com[1-9]|lpt[1-9])($|\.)/i;

/**
 * Map a cloud/S3 object key to a path that can exist on the local vault filesystem.
 * On Linux/macOS/mobile the cloud key is used as-is.
 */
export function toLocalVaultPath(cloudKey: string): string {
	if (!Platform.isWin) {
		return cloudKey;
	}
	return sanitizePathForWindows(cloudKey);
}

export function sanitizePathForWindows(path: string): string {
	return path
		.split('/')
		.filter(Boolean)
		.map(sanitizePathSegmentForWindows)
		.join('/');
}

function sanitizePathSegmentForWindows(segment: string): string {
	let sanitized = segment.replace(WINDOWS_INVALID_CHARS, '_');
	sanitized = sanitized.replace(/[.\s]+$/, '');
	if (!sanitized) {
		sanitized = '_';
	}
	if (WINDOWS_RESERVED_NAME.test(sanitized)) {
		sanitized = `_${sanitized}`;
	}
	return sanitized;
}

/**
 * Resolve a vault path using the index's canonical casing.
 * On Windows the filesystem is case-insensitive but Obsidian path lookups are not.
 */
export function resolveVaultPath(vault: Vault, path: string): string | null {
	const normalized = normalizePath(path);
	const direct = vault.getAbstractFileByPath(normalized);
	if (direct) {
		return direct.path;
	}

	if (!Platform.isWin) {
		return null;
	}

	const targetLower = normalized.toLowerCase();
	for (const item of vault.getAllLoadedFiles()) {
		if (item.path.toLowerCase() === targetLower) {
			return item.path;
		}
	}

	return null;
}

export function resolveVaultFile(vault: Vault, path: string): TFile | null {
	const resolved = resolveVaultPath(vault, path);
	if (!resolved) {
		return null;
	}

	const file = vault.getAbstractFileByPath(resolved);
	return file instanceof TFile ? file : null;
}

export async function ensureParentFolders(
	vault: Vault,
	path: string,
): Promise<void> {
	const parts = path.split('/').filter(Boolean);
	parts.pop();

	let current = '';
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;

		const existing = resolveVaultPath(vault, current);
		if (existing) {
			current = existing;
			continue;
		}

		try {
			await vault.createFolder(current);
		} catch (error) {
			const created = resolveVaultPath(vault, current);
			if (created) {
				current = created;
				continue;
			}
			throw error;
		}
	}
}

export async function writeVaultBinary(
	vault: Vault,
	path: string,
	content: ArrayBuffer,
): Promise<TFile> {
	const normalized = normalizePath(path);
	const existing = resolveVaultFile(vault, normalized);

	if (existing) {
		await vault.modifyBinary(existing, content);
		const updated = resolveVaultFile(vault, normalized);
		if (updated) {
			return updated;
		}
		return existing;
	}

	await ensureParentFolders(vault, normalized);

	try {
		await vault.createBinary(normalized, content);
	} catch (error) {
		const created = resolveVaultFile(vault, normalized);
		if (created) {
			await vault.modifyBinary(created, content);
			return created;
		}
		throw error;
	}

	const saved = resolveVaultFile(vault, normalized);
	if (!saved) {
		throw new Error(`Failed to save file locally: ${normalized}`);
	}

	return saved;
}
