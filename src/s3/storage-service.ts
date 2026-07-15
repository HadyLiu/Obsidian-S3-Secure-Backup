import {
	CopyObjectCommand,
	DeleteObjectCommand,
	PutObjectCommand,
	type S3Client,
} from '@aws-sdk/client-s3';
import type { S3BackupSettings } from '../settings';
import { createS3Client } from './client';

export class S3StorageService {
	private readonly client: S3Client;
	private readonly bucket: string;

	constructor(settings: S3BackupSettings) {
		this.client = createS3Client(settings);
		this.bucket = settings.bucket.trim();
	}

	async upload(
		key: string,
		content: ArrayBuffer,
		contentMd5: string,
	): Promise<void> {
		await this.client.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: key,
				Body: new Uint8Array(content),
				ContentLength: content.byteLength,
				ContentMD5: contentMd5,
			}),
		);
	}

	async copyToWaste(sourceKey: string, destinationKey: string): Promise<void> {
		await this.client.send(
			new CopyObjectCommand({
				Bucket: this.bucket,
				Key: destinationKey,
				CopySource: encodeCopySource(this.bucket, sourceKey),
			}),
		);
	}

	async delete(key: string): Promise<void> {
		await this.client.send(
			new DeleteObjectCommand({
				Bucket: this.bucket,
				Key: key,
			}),
		);
	}

	destroy(): void {
		this.client.destroy();
	}
}

function encodeCopySource(bucket: string, key: string): string {
	const encodedBucket = encodeURIComponent(bucket);
	const encodedKey = key
		.split('/')
		.map((segment) => encodeURIComponent(segment))
		.join('/');
	return `${encodedBucket}/${encodedKey}`;
}
