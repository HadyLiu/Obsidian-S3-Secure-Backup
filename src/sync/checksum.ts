import SparkMD5 from 'spark-md5';

export interface Md5Checksum {
	hex: string;
	base64: string;
}

export function calculateMd5(content: ArrayBuffer): Md5Checksum {
	const hex = SparkMD5.ArrayBuffer.hash(content);
	const binary = SparkMD5.ArrayBuffer.hash(content, true);
	return {
		hex,
		base64: binaryToBase64(binary),
	};
}

function binaryToBase64(binary: string): string {
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}

	let result = '';
	for (let index = 0; index < bytes.length; index += 1) {
		result += String.fromCharCode(bytes[index] ?? 0);
	}
	return window.btoa(result);
}
