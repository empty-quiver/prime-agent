import { closeSync, constants, fstatSync, opendirSync, openSync, readSync } from "node:fs";

export function* journalFiles(directory: string): Generator<string> {
	const handle = opendirSync(directory);
	try {
		for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
			if (entry.name.endsWith(".json")) {
				if (!entry.isFile()) throw new Error("Journal record must be a regular file");
				yield entry.name;
			}
		}
	} finally {
		handle.closeSync();
	}
}

export function readJournalJson(path: string, maxBytes: number): unknown {
	const handle = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(handle);
		if (!stat.isFile() || stat.size > maxBytes) throw new Error("Journal record exceeded its size limit");
		const buffer = Buffer.alloc(stat.size + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const count = readSync(handle, buffer, offset, buffer.length - offset, null);
			if (!count) break;
			offset += count;
		}
		if (offset !== stat.size) throw new Error("Journal record changed during read");
		return JSON.parse(buffer.subarray(0, offset).toString("utf8"));
	} finally {
		closeSync(handle);
	}
}
