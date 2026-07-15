import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import type { S3BackupSettings } from '../settings';
import { ObsidianHttpHandler } from './obsidian-http-handler';

function normalizeEndpoint(endpoint: string): string {
	return endpoint.trim().replace(/\/+$/, '');
}

function shouldUsePathStyle(endpoint: string): boolean {
	// Cloudflare R2 works with virtual-hosted-style (official SDK example).
	// Path-style is mainly needed for MinIO and some self-hosted gateways.
	const host = endpoint.toLowerCase();
	if (host.includes('r2.cloudflarestorage.com')) {
		return false;
	}
	return true;
}

export function createS3Client(settings: S3BackupSettings): S3Client {
	const endpoint = normalizeEndpoint(settings.endpoint);

	return new S3Client({
		endpoint,
		region: settings.region.trim() || 'auto',
		credentials: {
			accessKeyId: settings.accessKeyId.trim(),
			secretAccessKey: settings.secretAccessKey.trim(),
		},
		forcePathStyle: shouldUsePathStyle(endpoint),
		// Required for R2 and many S3-compatible backends with AWS SDK >= 3.729
		requestChecksumCalculation: 'WHEN_REQUIRED',
		responseChecksumValidation: 'WHEN_REQUIRED',
		requestHandler: new ObsidianHttpHandler(),
	});
}

function formatS3Error(error: unknown): string {
	if (!(error instanceof Error)) {
		return 'Unknown connection error.';
	}

	const awsError = error as Error & {
		name?: string;
		Code?: string;
		code?: string;
		$metadata?: { httpStatusCode?: number };
	};

	const parts: string[] = [];
	const status = awsError.$metadata?.httpStatusCode;
	if (status !== undefined) {
		parts.push(`HTTP ${status}`);
	}

	const code = awsError.Code ?? awsError.code ?? awsError.name;
	if (code && code !== 'Error') {
		parts.push(String(code));
	}

	if (awsError.message) {
		parts.push(awsError.message);
	}

	return parts.join(' — ') || 'Unknown connection error.';
}

export async function testBucketConnection(
	settings: S3BackupSettings,
): Promise<{ ok: true } | { ok: false; message: string }> {
	if (!settings.endpoint.trim()) {
		return { ok: false, message: 'Endpoint is required.' };
	}
	if (!settings.bucket.trim()) {
		return { ok: false, message: 'Bucket is required.' };
	}
	if (!settings.accessKeyId.trim() || !settings.secretAccessKey.trim()) {
		return { ok: false, message: 'Access key ID and secret are required.' };
	}

	const client = createS3Client(settings);

	try {
		await client.send(
			new ListObjectsV2Command({
				Bucket: settings.bucket.trim(),
				MaxKeys: 1,
			}),
		);
		return { ok: true };
	} catch (error) {
		return { ok: false, message: formatS3Error(error) };
	} finally {
		client.destroy();
	}
}
