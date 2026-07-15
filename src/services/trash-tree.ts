const WASTE_PREFIX = '.wastePaper/';
const PICKUP_PREFIX = '.pickUpPaper/';
const TIMESTAMP_PATTERN = /(\d{8}_\d{6})_/;

export interface TrashItem {
	key: string;
	name: string;
	originalPath: string;
	folderPath: string;
}

export interface TrashFolderNode {
	name: string;
	path: string;
	folders: TrashFolderNode[];
	items: TrashItem[];
}

export function parseWasteKey(key: string): TrashItem | null {
	if (!key.startsWith(WASTE_PREFIX) || key.endsWith('/')) {
		return null;
	}

	const relative = key.slice(WASTE_PREFIX.length);
	const timestampIndex = relative.search(TIMESTAMP_PATTERN);
	if (timestampIndex < 0) {
		return null;
	}

	const match = relative.slice(timestampIndex).match(/^(\d{8}_\d{6})_(.+)$/);
	if (!match) {
		return null;
	}

	const directory = relative.slice(0, timestampIndex);
	const filename = match[2] ?? '';
	const originalPath = `${directory}${filename}`;
	const folderPath = directory.includes('/')
		? directory.slice(0, -1)
		: '';

	return {
		key,
		name: filename,
		originalPath,
		folderPath,
	};
}

export function buildTrashTree(items: TrashItem[]): TrashFolderNode {
	const root = createFolderNode('Trash', '');
	for (const item of items) {
		insertTrashItem(root, item);
	}
	sortTrashTree(root);
	return root;
}

export function createPickupKey(originalPath: string, restoredAt: Date): string {
	return `${PICKUP_PREFIX}${formatTimestamp(restoredAt)}_${originalPath}`;
}

function insertTrashItem(root: TrashFolderNode, item: TrashItem): void {
	const segments = item.folderPath
		? item.folderPath.split('/').filter(Boolean)
		: [];
	let current = root;

	for (const segment of segments) {
		let child = current.folders.find((folder) => folder.name === segment);
		if (!child) {
			child = createFolderNode(
				segment,
				current.path ? `${current.path}/${segment}` : segment,
			);
			current.folders.push(child);
		}
		current = child;
	}

	current.items.push(item);
}

function createFolderNode(name: string, path: string): TrashFolderNode {
	return {
		name,
		path,
		folders: [],
		items: [],
	};
}

function sortTrashTree(node: TrashFolderNode): void {
	node.folders.sort((left, right) => left.name.localeCompare(right.name));
	node.items.sort((left, right) => left.name.localeCompare(right.name));
	for (const folder of node.folders) {
		sortTrashTree(folder);
	}
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
