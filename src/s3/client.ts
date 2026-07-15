import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { validateS3Endpoint } from '../security/validation';
import type { S3BackupSettings } from '../settings';
import { ObsidianHttpHandler } from './obsidian-http-handler';

function normalizeEndpoint(endpoint: string): string {
	return validateS3Endpoint(endpoint);
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

	const client = new S3Client({
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

	// R2 rejects flexible checksum headers that newer AWS SDK versions may attach.
	client.middlewareStack.add(
		(next) => async (args) => {
			const request = args.request as { headers?: Record<string, string> };
			if (request.headers) {
				for (const key of Object.keys(request.headers)) {
					const lower = key.toLowerCase();
					if (
						lower.startsWith('x-amz-checksum-') ||
						lower === 'x-amz-sdk-checksum-algorithm' ||
						lower === 'x-amz-trailer' ||
						lower === 'x-amz-decoded-content-length'
					) {
						delete request.headers[key];
					}
				}
			}
			return next(args);
		},
		{
			step: 'build',
			name: 'stripFlexibleChecksumHeaders',
			priority: 'low',
		},
	);

	return client;
}

export function formatS3Error(error: unknown): string {
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

	return parts.join(' — ') || 'Request failed. See the endpoint and permissions.';
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

	try {
		const client = createS3Client(settings);
		try {
			await client.send(
				new ListObjectsV2Command({
					Bucket: settings.bucket.trim(),
					MaxKeys: 1,
				}),
			);
			return { ok: true };
		} finally {
			client.destroy();
		}
	} catch (error) {
		return { ok: false, message: formatS3Error(error) };
	}
}
