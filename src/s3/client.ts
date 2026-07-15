import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import type { S3BackupSettings } from '../settings';

export function createS3Client(settings: S3BackupSettings): S3Client {
	return new S3Client({
		endpoint: settings.endpoint,
		region: settings.region,
		credentials: {
			accessKeyId: settings.accessKeyId,
			secretAccessKey: settings.secretAccessKey,
		},
		forcePathStyle: true,
	});
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
				Bucket: settings.bucket,
				MaxKeys: 1,
			}),
		);
		client.destroy();
		return { ok: true };
	} catch (error) {
		client.destroy();
		const message =
			error instanceof Error ? error.message : 'Unknown connection error.';
		return { ok: false, message };
	}
}
