import { normalizePath } from 'obsidian';

const LOOPBACK_HOSTS = new Set(['localhost', '0.0.0.0', '::1', '[::1]']);

export function validateS3Endpoint(endpoint: string): string {
	const trimmed = endpoint.trim();
	let parsed: URL;

	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error('Endpoint must be a valid HTTPS URL.');
	}

	if (parsed.protocol !== 'https:') {
		throw new Error('Endpoint must use HTTPS.');
	}
	if (parsed.username || parsed.password) {
		throw new Error('Endpoint must not contain embedded credentials.');
	}
	if (parsed.search || parsed.hash) {
		throw new Error('Endpoint must not contain a query string or fragment.');
	}

	const hostname = parsed.hostname.toLowerCase();
	if (
		LOOPBACK_HOSTS.has(hostname) ||
		hostname.startsWith('127.') ||
		hostname === '169.254.169.254'
	) {
		throw new Error('Loopback and instance-metadata endpoints are not allowed.');
	}

	return trimmed.replace(/\/+$/, '');
}

export function validateVaultRelativePath(
	path: string,
	configDir?: string,
): string {
	const trimmed = path.trim();
	if (!trimmed) {
		throw new Error('Path must not be empty.');
	}
	if (trimmed !== path) {
		throw new Error(`Vault path must not have outer whitespace: ${path}`);
	}
	if (
		trimmed.startsWith('/') ||
		trimmed.startsWith('\\') ||
		trimmed.includes('\\') ||
		hasControlCharacter(trimmed)
	) {
		throw new Error(`Unsafe vault path: ${path}`);
	}

	const segments = trimmed.split('/').filter((segment) => segment.length > 0);
	if (segments.some((segment) => segment === '.' || segment === '..')) {
		throw new Error(`Unsafe vault path: ${path}`);
	}

	const normalized = normalizePath(segments.join('/'));
	if (!normalized || normalized === '.') {
		throw new Error(`Unsafe vault path: ${path}`);
	}
	const canonicalInput = trimmed.replace(/\/+$/, '');
	if (normalized !== canonicalInput) {
		throw new Error(`Ambiguous vault path: ${path}`);
	}

	const lowerPath = normalized.toLowerCase();
	if (lowerPath === '.trash' || lowerPath.startsWith('.trash/')) {
		throw new Error('Writing to the vault trash directory is blocked.');
	}

	if (configDir) {
		const normalizedConfigDir = normalizePath(configDir).toLowerCase();
		if (
			lowerPath === normalizedConfigDir ||
			lowerPath.startsWith(`${normalizedConfigDir}/`)
		) {
			throw new Error('Writing to the Obsidian configuration directory is blocked.');
		}
	}

	return normalized;
}

export function joinSafeVaultPath(
	basePath: string,
	childPath: string,
	configDir?: string,
): string {
	const safeBase = validateVaultRelativePath(basePath, configDir);
	const safeChild = validateVaultRelativePath(childPath, configDir);
	const joined = validateVaultRelativePath(
		`${safeBase}/${safeChild}`,
		configDir,
	);

	if (joined !== safeBase && !joined.startsWith(`${safeBase}/`)) {
		throw new Error('Resolved path escapes the selected vault folder.');
	}
	return joined;
}

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
			return true;
		}
	}
	return false;
}
