import {
	CopyObjectCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	type S3Client,
} from '@aws-sdk/client-s3';
import type { S3BackupSettings } from '../settings';
import { isSystemObjectKey } from '../sync/paths';
import { createS3Client } from './client';

export interface CloudObject {
	key: string;
	etag: string;
	size: number;
}

export class S3StorageService {
	private readonly client: S3Client;
	private readonly bucket: string;

	constructor(settings: S3BackupSettings) {
		this.client = createS3Client(settings);
		this.bucket = settings.bucket.trim();
	}

	async listObjectsByPrefix(prefix: string): Promise<CloudObject[]> {
		const objects: CloudObject[] = [];
		let continuationToken: string | undefined;

		do {
			const response = await this.client.send(
				new ListObjectsV2Command({
					Bucket: this.bucket,
					Prefix: prefix,
					ContinuationToken: continuationToken,
				}),
			);

			for (const item of response.Contents ?? []) {
				if (!item.Key) {
					continue;
				}
				objects.push({
					key: item.Key,
					etag: item.ETag ?? '',
					size: item.Size ?? 0,
				});
			}

			continuationToken = response.IsTruncated
				? response.NextContinuationToken
				: undefined;
		} while (continuationToken);

		return objects;
	}

	async listVaultObjects(): Promise<CloudObject[]> {
		const objects: CloudObject[] = [];
		let continuationToken: string | undefined;

		do {
			const response = await this.client.send(
				new ListObjectsV2Command({
					Bucket: this.bucket,
					ContinuationToken: continuationToken,
				}),
			);

			for (const item of response.Contents ?? []) {
				if (!item.Key || isSystemObjectKey(item.Key)) {
					continue;
				}
				objects.push({
					key: item.Key,
					etag: item.ETag ?? '',
					size: item.Size ?? 0,
				});
			}

			continuationToken = response.IsTruncated
				? response.NextContinuationToken
				: undefined;
		} while (continuationToken);

		return objects;
	}

	async download(key: string): Promise<ArrayBuffer> {
		const response = await this.client.send(
			new GetObjectCommand({
				Bucket: this.bucket,
				Key: key,
			}),
		);

		if (!response.Body) {
			throw new Error('Empty object body.');
		}

		const bytes = await response.Body.transformToByteArray();
		return copyArrayBufferView(bytes);
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

	async copyObject(sourceKey: string, destinationKey: string): Promise<void> {
		await this.client.send(
			new CopyObjectCommand({
				Bucket: this.bucket,
				Key: destinationKey,
				CopySource: encodeCopySource(this.bucket, sourceKey),
			}),
		);
	}

	async copyToWaste(sourceKey: string, destinationKey: string): Promise<void> {
		await this.copyObject(sourceKey, destinationKey);
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

function copyArrayBufferView(view: ArrayBufferView): ArrayBuffer {
	const copy = new Uint8Array(view.byteLength);
	copy.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
	return copy.buffer;
}
