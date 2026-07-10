#!/usr/bin/env node

import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, rename, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const [, , inputPath, outputPath, mappingPath = new URL('./query-server-build-map.json', import.meta.url)] =
	process.argv;

if (!inputPath || !outputPath) {
	console.error('Usage: node scripts/backfill-query-server-build.mjs INPUT.jsonl OUTPUT.jsonl [MAPPING.json]');
	process.exit(2);
}

const mapping = JSON.parse(await readFile(mappingPath, 'utf8'));
const temporaryPath = `${outputPath}.tmp`;
const output = createWriteStream(temporaryPath, { encoding: 'utf8' });
const counts = new Map();
let rows = 0;

try {
	for await (const line of createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity })) {
		if (!line.trim()) continue;

		const row = JSON.parse(line);
		const processId = row.mcpServerSessionId;
		const build = mapping[processId];
		if (!build) {
			throw new Error(`No server build mapping for mcpServerSessionId ${String(processId)}`);
		}

		row.serverVersion ??= build.serverVersion;
		row.serverBuildSha ??= build.serverBuildSha;
		output.write(`${JSON.stringify(row)}\n`);
		counts.set(processId, (counts.get(processId) ?? 0) + 1);
		rows += 1;
	}

	await new Promise((resolve, reject) => {
		output.once('error', reject);
		output.end(resolve);
	});
	await rename(temporaryPath, outputPath);
} catch (error) {
	output.destroy();
	await rm(temporaryPath, { force: true });
	throw error;
}

console.log(JSON.stringify({ rows, processCounts: Object.fromEntries(counts) }, null, 2));
