import { Platform } from 'obsidian';
import type { FileRecord } from '../database/metadata-store';
import { toLocalVaultPath } from './vault-paths';

export interface SanitizedPathCollision {
	localPath: string;
	cloudKeys: string[];
}

export class WindowsPathCollisionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WindowsPathCollisionError';
	}
}

export function detectSanitizedPathCollisions(
	cloudKeys: Iterable<string>,
): SanitizedPathCollision[] {
	if (!Platform.isWin) {
		return [];
	}

	const groups = new Map<string, string[]>();
	for (const cloudKey of cloudKeys) {
		const localPath = toLocalVaultPath(cloudKey);
		const bucket = groups.get(localPath) ?? [];
		bucket.push(cloudKey);
		groups.set(localPath, bucket);
	}

	const collisions: SanitizedPathCollision[] = [];
	for (const [localPath, keys] of groups) {
		if (keys.length > 1) {
			collisions.push({ localPath, cloudKeys: [...keys] });
		}
	}
	return collisions;
}

export function formatPathCollisionWarning(
	collision: SanitizedPathCollision,
): string {
	const keys = collision.cloudKeys.map((key) => `"${key}"`).join(', ');
	return (
		`Windows path collision at "${collision.localPath}": cloud keys ${keys} ` +
		'map to the same local path. Skipped to avoid overwrite — rename one on Linux/mobile.'
	);
}

/**
 * Tracks cloud key → local path ownership and reports Windows sanitize collisions.
 */
export class WindowsPathCollisionTracker {
	private readonly localPathToCloudKey = new Map<string, string>();
	private readonly blockedCloudKeys = new Set<string>();
	private readonly reported = new Set<string>();
	readonly warnings: string[] = [];

	constructor(existingFiles: Record<string, FileRecord>) {
		for (const [cloudKey, record] of Object.entries(existingFiles)) {
			this.registerExisting(cloudKey, record.path);
		}
	}

	reportBatchCollisions(collisions: SanitizedPathCollision[]): void {
		for (const collision of collisions) {
			this.reportCollision(collision);
			for (const cloudKey of collision.cloudKeys) {
				this.blockedCloudKeys.add(cloudKey);
			}
		}
	}

	isCloudKeyBlocked(cloudKey: string): boolean {
		return this.blockedCloudKeys.has(cloudKey);
	}

	/**
	 * Reserve a local path for a cloud key before writing.
	 * @throws WindowsPathCollisionError when another cloud key already owns the path.
	 */
	assertWritable(cloudKey: string, localPath: string): void {
		const owner = this.localPathToCloudKey.get(localPath);
		if (owner && owner !== cloudKey) {
			const warning = formatPathCollisionWarning({
				localPath,
				cloudKeys: [owner, cloudKey],
			});
			this.reportWarning(warning);
			throw new WindowsPathCollisionError(warning);
		}

		this.localPathToCloudKey.set(localPath, cloudKey);
	}

	private registerExisting(cloudKey: string, localPath: string): void {
		const owner = this.localPathToCloudKey.get(localPath);
		if (owner && owner !== cloudKey) {
			this.reportCollision({ localPath, cloudKeys: [owner, cloudKey] });
			this.blockedCloudKeys.add(cloudKey);
			this.blockedCloudKeys.add(owner);
			return;
		}
		this.localPathToCloudKey.set(localPath, cloudKey);
	}

	private reportCollision(collision: SanitizedPathCollision): void {
		this.reportWarning(formatPathCollisionWarning(collision));
	}

	private reportWarning(message: string): void {
		if (this.reported.has(message)) {
			return;
		}
		this.reported.add(message);
		this.warnings.push(message);
	}
}
