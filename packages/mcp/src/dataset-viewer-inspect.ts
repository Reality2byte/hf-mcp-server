import { datasetInfo, HubApiError } from '@huggingface/hub';
import { HfApiCall, HfApiError } from './hf-api-call.js';
import { escapeMarkdown, formatBytes, formatDate, formatNumber } from './utilities.js';

const DATASET_VIEWER_BASE_URL = 'https://datasets-server.huggingface.co';
const DEFAULT_PREVIEW_LIMIT = 5;
const MAX_PREVIEW_LIMIT = 100;
const MAX_TABLE_COLUMNS = 30;
const MAX_ROW_PREVIEW_CHARS = 66_000;
const MAX_URLS_TO_SHOW = 5;

export interface DatasetStructureOptions {
	config?: string;
	split?: string;
}

export interface DatasetPreviewOptions {
	config?: string;
	split?: string;
	offset?: number;
	limit?: number;
}

interface DatasetViewerClientLike {
	getJson<T>(path: string, params: Record<string, string | number | undefined>): Promise<T>;
}

interface DatasetMetadataProvider {
	getMetadata(datasetId: string): Promise<DatasetStructureMetadata>;
}

export interface DatasetViewerInspectorOptions {
	client?: DatasetViewerClientLike;
	metadataProvider?: DatasetMetadataProvider;
	hubUrl?: string;
}

interface DatasetStructureMetadata {
	name: string;
	author?: string;
	description?: string;
	downloadsAllTime?: number;
	likes?: number;
	gated?: false | 'auto' | 'manual';
	private?: boolean;
	updatedAt?: Date | string;
	createdAt?: Date | string;
	tags?: string[];
	sha?: string;
	cardData?: Record<string, unknown>;
}

interface ViewerSplit {
	dataset: string;
	config: string;
	split: string;
}

interface ViewerSizeEntry {
	dataset?: string;
	config?: string;
	split?: string;
	numRows?: number;
	estimatedNumRows?: number | null;
	numColumns?: number;
	numBytesOriginalFiles?: number | null;
	numBytesParquetFiles?: number | null;
	numBytesMemory?: number | null;
}

interface ViewerSize {
	dataset?: ViewerSizeEntry;
	configs: ViewerSizeEntry[];
	splits: ViewerSizeEntry[];
	pending: unknown[];
	failed: unknown[];
	partial: boolean;
}

interface ViewerParquetFile {
	dataset?: string;
	config: string;
	split: string;
	url: string;
	filename?: string;
	size: number;
}

interface ViewerParquet {
	files: ViewerParquetFile[];
	pending: unknown[];
	failed: unknown[];
	partial: boolean;
}

interface ViewerFeature {
	name: string;
	type: unknown;
}

interface ViewerRow {
	rowIdx: number;
	row: Record<string, unknown>;
	truncatedCells: string[];
}

interface ViewerRows {
	features: ViewerFeature[];
	rows: ViewerRow[];
	numRowsTotal?: number;
	numRowsPerPage?: number;
	partial: boolean;
}

interface EndpointResult<T> {
	data?: T;
	warning?: string;
}

class DatasetViewerClient extends HfApiCall<Record<string, string | number | undefined>, unknown> {
	constructor(hfToken?: string) {
		super(DATASET_VIEWER_BASE_URL, hfToken);
	}

	async getJson<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
		const url = new URL(path, this.apiUrl);
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}
		return this.fetchFromApi<T>(url);
	}
}

class HubDatasetMetadataProvider implements DatasetMetadataProvider {
	constructor(
		private readonly hfToken?: string,
		private readonly hubUrl?: string
	) {}

	async getMetadata(datasetId: string): Promise<DatasetStructureMetadata> {
		const additionalFields = [
			'author',
			'description',
			'downloadsAllTime',
			'tags',
			'cardData',
			'sha',
			'createdAt',
		] as const;
		const info = await datasetInfo<(typeof additionalFields)[number]>({
			name: datasetId,
			additionalFields: Array.from(additionalFields),
			...(this.hfToken && { credentials: { accessToken: this.hfToken } }),
			...(this.hubUrl && { hubUrl: this.hubUrl }),
		});
		return {
			name: info.name,
			author: info.author,
			description: info.description,
			downloadsAllTime: info.downloadsAllTime,
			likes: info.likes,
			gated: info.gated,
			private: info.private,
			updatedAt: info.updatedAt,
			createdAt: info.createdAt,
			tags: info.tags,
			sha: info.sha,
			cardData: isRecord(info.cardData) ? info.cardData : undefined,
		};
	}
}

export class DatasetViewerInspector {
	private readonly client: DatasetViewerClientLike;
	private readonly metadataProvider: DatasetMetadataProvider;

	constructor(hfToken?: string, options: DatasetViewerInspectorOptions = {}) {
		this.client = options.client ?? new DatasetViewerClient(hfToken);
		this.metadataProvider = options.metadataProvider ?? new HubDatasetMetadataProvider(hfToken, options.hubUrl);
	}

	async getStructure(datasetId: string, options: DatasetStructureOptions = {}): Promise<string> {
		const lines: string[] = ['## Dataset Structure', ''];
		let metadata: DatasetStructureMetadata | undefined;
		try {
			metadata = await this.metadataProvider.getMetadata(datasetId);
			lines.push(...formatMetadata(metadata));
		} catch (error) {
			lines.push(`> Could not fetch Hub dataset metadata: ${formatErrorMessage(error)}`, '');
		}

		const splitsResult = await this.fetchSplits(datasetId);
		const sizeResult = await this.fetchSize(datasetId);
		const parquetResult = await this.fetchParquet(datasetId);

		if (splitsResult.warning) lines.push(`> ${splitsResult.warning}`, '');
		if (sizeResult.warning) lines.push(`> ${sizeResult.warning}`, '');
		if (parquetResult.warning) lines.push(`> ${parquetResult.warning}`, '');

		const splits = splitsResult.data ?? [];
		const size = sizeResult.data;
		if (splits.length > 0 || size) {
			lines.push(...formatSplitsAndSize(splits, size));
		}
		if (parquetResult.data) {
			lines.push(...formatParquet(parquetResult.data));
		}

		const target = resolveStructureTarget(splits, options);
		if (target) {
			const rowsResult = await this.fetchRows(datasetId, target.config, target.split, 0, 1);
			if (rowsResult.data) {
				lines.push(...formatSchemaPreview(rowsResult.data, target.config, target.split));
			} else if (rowsResult.warning) {
				lines.push('### Schema Preview', '', `> ${rowsResult.warning}`, '');
			}
		} else if (splits.length === 0) {
			lines.push('### Schema Preview', '', '> No config/split target was available for schema preview.', '');
		}

		if (metadata && !lines.some((line) => line.startsWith('**Link:**'))) {
			lines.push(`**Link:** [https://hf.co/datasets/${metadata.name}](https://hf.co/datasets/${metadata.name})`);
		}

		return trimBlankLines(lines).join('\n');
	}

	async getPreview(datasetId: string, options: DatasetPreviewOptions): Promise<string> {
		const offset = options.offset ?? 0;
		if (!Number.isInteger(offset) || offset < 0) {
			return '## Dataset Preview\n\n- Error: `offset` must be a non-negative integer.';
		}
		const limit = clampLimit(options.limit);
		const splitsResult = await this.fetchSplits(datasetId);
		if (!splitsResult.data) {
			return `## Dataset Preview\n\n- Error: ${splitsResult.warning ?? 'Could not fetch dataset splits.'}`;
		}

		const resolved = resolvePreviewTarget(splitsResult.data, options.config, options.split);
		if (!resolved.ok) {
			return ['## Dataset Preview', '', resolved.message].join('\n');
		}

		const rowsResult = await this.fetchRows(datasetId, resolved.config, resolved.split, offset, limit);
		if (!rowsResult.data) {
			return [
				'## Dataset Preview',
				'',
				`- Dataset: \`${datasetId}\``,
				`- Config: \`${resolved.config}\``,
				`- Split: \`${resolved.split}\``,
				'',
				`> ${rowsResult.warning ?? 'Could not fetch row preview.'}`,
			].join('\n');
		}

		return formatPreview(datasetId, resolved.config, resolved.split, offset, limit, rowsResult.data).join('\n');
	}

	private async fetchSplits(datasetId: string): Promise<EndpointResult<ViewerSplit[]>> {
		try {
			const raw = await this.client.getJson<unknown>('/splits', { dataset: datasetId });
			return { data: parseSplits(raw) };
		} catch (error) {
			return { warning: `Could not fetch splits from Dataset Viewer: ${formatErrorMessage(error)}` };
		}
	}

	private async fetchSize(datasetId: string): Promise<EndpointResult<ViewerSize>> {
		try {
			const raw = await this.client.getJson<unknown>('/size', { dataset: datasetId });
			return { data: parseSize(raw) };
		} catch (error) {
			return { warning: `Could not fetch size information from Dataset Viewer: ${formatErrorMessage(error)}` };
		}
	}

	private async fetchParquet(datasetId: string): Promise<EndpointResult<ViewerParquet>> {
		try {
			const raw = await this.client.getJson<unknown>('/parquet', { dataset: datasetId });
			return { data: parseParquet(raw) };
		} catch (error) {
			return {
				warning: `Could not fetch parquet export information from Dataset Viewer: ${formatErrorMessage(error)}`,
			};
		}
	}

	private async fetchRows(
		datasetId: string,
		config: string,
		split: string,
		offset: number,
		length: number
	): Promise<EndpointResult<ViewerRows>> {
		try {
			const raw = await this.client.getJson<unknown>('/rows', { dataset: datasetId, config, split, offset, length });
			return { data: parseRows(raw) };
		} catch (error) {
			return { warning: `Could not fetch rows from Dataset Viewer: ${formatErrorMessage(error)}` };
		}
	}
}

function parseSplits(raw: unknown): ViewerSplit[] {
	const root = expectRecord(raw, '/splits response');
	const splitsRaw = root.splits;
	if (!Array.isArray(splitsRaw)) return [];
	return splitsRaw
		.map((entry): ViewerSplit | undefined => {
			if (!isRecord(entry)) return undefined;
			const dataset = stringValue(entry.dataset);
			const config = stringValue(entry.config);
			const split = stringValue(entry.split);
			if (!dataset || !config || !split) return undefined;
			return { dataset, config, split };
		})
		.filter(isDefined)
		.sort(compareConfigSplit);
}

function parseSize(raw: unknown): ViewerSize {
	const root = expectRecord(raw, '/size response');
	const sizeRoot = isRecord(root.size) ? root.size : {};
	return {
		dataset: parseSizeEntry(sizeRoot.dataset),
		configs: parseSizeEntries(sizeRoot.configs),
		splits: parseSizeEntries(sizeRoot.splits).sort(compareSizeEntry),
		pending: Array.isArray(root.pending) ? root.pending : [],
		failed: Array.isArray(root.failed) ? root.failed : [],
		partial: root.partial === true,
	};
}

function parseSizeEntries(raw: unknown): ViewerSizeEntry[] {
	return Array.isArray(raw) ? raw.map(parseSizeEntry).filter(isDefined) : [];
}

function parseSizeEntry(raw: unknown): ViewerSizeEntry | undefined {
	if (!isRecord(raw)) return undefined;
	const config = stringValue(raw.config);
	const split = stringValue(raw.split);
	const entry: ViewerSizeEntry = {
		dataset: stringValue(raw.dataset),
		config,
		split,
		numRows: numberValue(raw.num_rows),
		estimatedNumRows: nullableNumberValue(raw.estimated_num_rows),
		numColumns: numberValue(raw.num_columns),
		numBytesOriginalFiles: nullableNumberValue(raw.num_bytes_original_files),
		numBytesParquetFiles: nullableNumberValue(raw.num_bytes_parquet_files),
		numBytesMemory: nullableNumberValue(raw.num_bytes_memory),
	};
	return entry;
}

function parseParquet(raw: unknown): ViewerParquet {
	const root = expectRecord(raw, '/parquet response');
	const files = Array.isArray(root.parquet_files)
		? root.parquet_files
				.map((entry): ViewerParquetFile | undefined => {
					if (!isRecord(entry)) return undefined;
					const config = stringValue(entry.config);
					const split = stringValue(entry.split);
					const url = stringValue(entry.url);
					const size = numberValue(entry.size);
					if (!config || !split || !url || size === undefined) return undefined;
					return {
						dataset: stringValue(entry.dataset),
						config,
						split,
						url,
						filename: stringValue(entry.filename),
						size,
					};
				})
				.filter(isDefined)
				.sort((a, b) => compareConfigSplit(a, b) || a.url.localeCompare(b.url))
		: [];
	return {
		files,
		pending: Array.isArray(root.pending) ? root.pending : [],
		failed: Array.isArray(root.failed) ? root.failed : [],
		partial: root.partial === true,
	};
}

function parseRows(raw: unknown): ViewerRows {
	const root = expectRecord(raw, '/rows response');
	const features = Array.isArray(root.features)
		? root.features
				.map((entry): ViewerFeature | undefined => {
					if (!isRecord(entry)) return undefined;
					const name = stringValue(entry.name);
					if (!name) return undefined;
					return { name, type: entry.type };
				})
				.filter(isDefined)
		: [];
	const rows = Array.isArray(root.rows)
		? root.rows
				.map((entry): ViewerRow | undefined => {
					if (!isRecord(entry) || !isRecord(entry.row)) return undefined;
					const rowIdx = numberValue(entry.row_idx);
					if (rowIdx === undefined) return undefined;
					return {
						rowIdx,
						row: entry.row,
						truncatedCells: Array.isArray(entry.truncated_cells)
							? entry.truncated_cells.filter((value): value is string => typeof value === 'string')
							: [],
					};
				})
				.filter(isDefined)
		: [];
	return {
		features,
		rows,
		numRowsTotal: numberValue(root.num_rows_total),
		numRowsPerPage: numberValue(root.num_rows_per_page),
		partial: root.partial === true,
	};
}

function formatMetadata(metadata: DatasetStructureMetadata): string[] {
	const lines: string[] = ['### Hub Metadata'];
	if (metadata.description) lines.push(truncateMarkdown(metadata.description, 500));
	const details: string[] = [];
	if (metadata.author) details.push(`- **Author:** ${metadata.author}`);
	if (metadata.downloadsAllTime !== undefined)
		details.push(`- **Downloads:** ${formatNumber(metadata.downloadsAllTime)}`);
	if (metadata.likes !== undefined) details.push(`- **Likes:** ${metadata.likes.toString()}`);
	if (metadata.updatedAt) details.push(`- **Updated:** ${formatDate(metadata.updatedAt)}`);
	if (metadata.createdAt) details.push(`- **Created:** ${formatDate(metadata.createdAt)}`);
	if (metadata.gated) details.push('- **Status:** 🔒 Gated');
	if (metadata.private) details.push('- **Status:** 🔐 Private');
	lines.push(...details);

	const card = metadata.cardData;
	if (card) {
		const cardLines: string[] = [];
		addCardValue(cardLines, 'License', card.license);
		addCardValue(cardLines, 'Language', card.language);
		addCardValue(cardLines, 'Task Categories', card.task_categories);
		addCardValue(cardLines, 'Size Categories', card.size_categories);
		addCardValue(cardLines, 'Pretty Name', card.pretty_name);
		addCardValue(cardLines, 'Papers With Code ID', card.paperswithcode_id);
		if (cardLines.length) lines.push(...cardLines);
	}
	if (metadata.tags && metadata.tags.length) {
		lines.push(
			`- **Tags:** ${metadata.tags
				.slice(0, 20)
				.map((tag) => `\`${tag}\``)
				.join(' ')}`
		);
	}
	lines.push('');
	return lines;
}

function formatSplitsAndSize(splits: ViewerSplit[], size: ViewerSize | undefined): string[] {
	const lines: string[] = ['### Configs and Splits'];
	const sizeByKey = new Map(size?.splits.map((entry) => [`${entry.config ?? ''}\n${entry.split ?? ''}`, entry]) ?? []);
	lines.push('| Config | Split | Rows | Estimated Rows | Columns | Parquet Size |');
	lines.push('|---|---|---:|---:|---:|---:|');
	const rows = splits.length
		? splits
		: (size?.splits ?? []).map((entry) => ({
				dataset: entry.dataset ?? '',
				config: entry.config ?? '',
				split: entry.split ?? '',
			}));
	for (const split of rows) {
		const entry = sizeByKey.get(`${split.config}\n${split.split}`);
		lines.push(
			`| ${[
				escapeTableCell(split.config),
				escapeTableCell(split.split),
				formatOptionalNumber(entry?.numRows),
				formatOptionalNumber(entry?.estimatedNumRows ?? undefined),
				formatOptionalNumber(entry?.numColumns),
				formatOptionalBytes(entry?.numBytesParquetFiles ?? undefined),
			].join(' | ')} |`
		);
	}
	if (size?.dataset) {
		const total = size.dataset;
		lines.push('');
		lines.push(
			`Total rows: ${formatOptionalNumber(total.numRows)}${total.estimatedNumRows ? ` (estimated ${formatNumber(total.estimatedNumRows)})` : ''}.`
		);
	}
	if (size?.partial)
		lines.push('', '> Size information is partial; estimated rows may be shown where exact counts are unavailable.');
	lines.push('');
	return lines;
}

function formatParquet(parquet: ViewerParquet): string[] {
	const lines: string[] = ['### Parquet Exports'];
	if (parquet.files.length === 0) {
		lines.push('', '> No parquet export files were listed.');
		if (parquet.pending.length) lines.push(`> Pending parquet jobs: ${parquet.pending.length.toString()}.`);
		if (parquet.failed.length) lines.push(`> Failed parquet jobs: ${parquet.failed.length.toString()}.`);
		lines.push('');
		return lines;
	}
	const groups = new Map<string, { config: string; split: string; files: number; size: number }>();
	for (const file of parquet.files) {
		const key = `${file.config}\n${file.split}`;
		const current = groups.get(key) ?? { config: file.config, split: file.split, files: 0, size: 0 };
		current.files += 1;
		current.size += file.size;
		groups.set(key, current);
	}
	const entries = [...groups.values()].sort(compareConfigSplit);
	lines.push('| Config | Split | Files | Total Size |');
	lines.push('|---|---|---:|---:|');
	for (const entry of entries) {
		lines.push(
			`| ${escapeTableCell(entry.config)} | ${escapeTableCell(entry.split)} | ${entry.files.toString()} | ${formatBytes(entry.size)} |`
		);
	}
	if (parquet.partial) lines.push('', '> Parquet export information is partial.');
	if (parquet.pending.length) lines.push('', `> Pending parquet jobs: ${parquet.pending.length.toString()}.`);
	if (parquet.failed.length) lines.push('', `> Failed parquet jobs: ${parquet.failed.length.toString()}.`);
	if (parquet.files.length <= MAX_URLS_TO_SHOW) {
		lines.push('', 'Parquet URLs:');
		for (const file of parquet.files)
			lines.push(`- \`${file.config}/${file.split}/${file.filename ?? 'file'}\`: ${file.url}`);
	} else {
		lines.push('', `Parquet file URLs omitted for brevity (${parquet.files.length.toString()} files).`);
	}
	lines.push('');
	return lines;
}

function formatSchemaPreview(rows: ViewerRows, config: string, split: string): string[] {
	const lines = ['### Schema Preview', '', `Using \`${config}/${split}\`.`, ''];
	lines.push(...formatFeatures(rows.features));
	if (rows.partial) lines.push('', '> Row/schema response is partial.');
	lines.push('');
	return lines;
}

function formatPreview(
	datasetId: string,
	config: string,
	split: string,
	offset: number,
	limit: number,
	rows: ViewerRows
): string[] {
	const end = rows.rows.length ? offset + rows.rows.length - 1 : offset;
	const lines = [
		'## Dataset Preview',
		'',
		`- Dataset: \`${datasetId}\``,
		`- Config: \`${config}\``,
		`- Split: \`${split}\``,
		`- Rows: \`${offset.toString()}-${end.toString()}\``,
		`- Requested limit: \`${limit.toString()}\``,
	];
	if (rows.numRowsTotal !== undefined) lines.push(`- Total rows: \`${formatNumber(rows.numRowsTotal)}\``);
	lines.push('', '### Features', '', ...formatFeatures(rows.features), '### Rows', '');
	lines.push(...formatRows(rows));
	if (rows.partial) lines.push('', '> Row response is partial.');
	return trimBlankLines(lines);
}

function formatFeatures(features: ViewerFeature[]): string[] {
	const lines = ['| # | Column | Type |', '|---:|---|---|'];
	features.forEach((feature, index) => {
		lines.push(
			`| ${(index + 1).toString()} | ${escapeTableCell(feature.name)} | ${escapeTableCell(formatFeatureType(feature.type))} |`
		);
	});
	if (features.length === 0) lines.push('| — | — | — |');
	lines.push('');
	return lines;
}

function formatRows(rows: ViewerRows): string[] {
	if (rows.rows.length === 0) return ['No rows returned.'];
	const columns = rows.features.map((feature) => feature.name);
	const visibleColumns = columns.slice(0, MAX_TABLE_COLUMNS);
	const omitted = columns.length - visibleColumns.length;
	const lines = [`| # | ${visibleColumns.map(escapeTableCell).join(' | ')} |`];
	lines.push(`|---:|${visibleColumns.map(() => '---').join('|')}|`);
	let rowPreviewChars = lines.join('\n').length;
	let truncatedByBudget = false;
	let truncatedByDatasetViewer = false;
	for (const row of rows.rows) {
		const cells = visibleColumns.map((column) => {
			if (row.truncatedCells.includes(column)) truncatedByDatasetViewer = true;
			return escapeTableCell(formatCell(row.row[column]));
		});
		const rowLine = `| ${row.rowIdx.toString()} | ${cells.join(' | ')} |`;
		const nextChars = rowPreviewChars + rowLine.length + 1;
		if (nextChars > MAX_ROW_PREVIEW_CHARS) {
			truncatedByBudget = true;
			if (lines.length === 2) {
				const remaining = Math.max(0, MAX_ROW_PREVIEW_CHARS - rowPreviewChars - 2);
				if (remaining > 0) lines.push(`${rowLine.slice(0, remaining)}… |`);
			}
			break;
		}
		lines.push(rowLine);
		rowPreviewChars = nextChars;
	}
	if (omitted > 0)
		lines.push(
			'',
			`Showing first ${visibleColumns.length.toString()} columns; omitted ${omitted.toString()} wider columns.`
		);
	if (truncatedByBudget) {
		lines.push(
			'',
			`Row preview output was truncated after approximately ${MAX_ROW_PREVIEW_CHARS.toLocaleString()} characters. Use a lower \`limit\`, narrower config/split, or later \`offset\` to inspect more.`
		);
	}
	if (truncatedByDatasetViewer) lines.push('', 'Dataset Viewer reported truncated cells in the returned rows.');
	return lines;
}

function resolveStructureTarget(splits: ViewerSplit[], options: DatasetStructureOptions): ViewerSplit | undefined {
	if (options.config && options.split) {
		const exact = splits.find((split) => split.config === options.config && split.split === options.split);
		return exact ?? { dataset: '', config: options.config, split: options.split };
	}
	return splits[0];
}

type PreviewTargetResult =
	| { ok: true; config: string; split: string }
	| {
			ok: false;
			message: string;
	  };

function resolvePreviewTarget(
	splits: ViewerSplit[],
	config: string | undefined,
	split: string | undefined
): PreviewTargetResult {
	if (splits.length === 0) {
		return { ok: false, message: 'No Dataset Viewer config/split options are available for this dataset.' };
	}
	if (config && split) {
		const exact = splits.find((entry) => entry.config === config && entry.split === split);
		if (exact) return { ok: true, config, split };
		return {
			ok: false,
			message: [`Config/split \`${config}\` / \`${split}\` was not found.`, '', ...formatAvailableOptions(splits)].join(
				'\n'
			),
		};
	}
	if (splits.length === 1) {
		const only = splits[0];
		if (!only) return { ok: false, message: 'No Dataset Viewer config/split options are available for this dataset.' };
		if ((config && config !== only.config) || (split && split !== only.split)) {
			return {
				ok: false,
				message: [
					`Config/split \`${config ?? only.config}\` / \`${split ?? only.split}\` was not found.`,
					'',
					...formatAvailableOptions(splits),
				].join('\n'),
			};
		}
		return { ok: true, config: config ?? only.config, split: split ?? only.split };
	}
	return {
		ok: false,
		message: [
			'`dataset_preview` requires `config` and `split` because this dataset has multiple choices.',
			'',
			...formatAvailableOptions(splits),
		].join('\n'),
	};
}

function formatAvailableOptions(splits: ViewerSplit[]): string[] {
	return ['Available options:', ...splits.slice(0, 50).map((entry) => `- \`${entry.config}\` / \`${entry.split}\``)];
}

function clampLimit(value: number | undefined): number {
	if (value === undefined) return DEFAULT_PREVIEW_LIMIT;
	if (!Number.isInteger(value)) return DEFAULT_PREVIEW_LIMIT;
	if (value < 1) return 1;
	return Math.min(value, MAX_PREVIEW_LIMIT);
}

function formatFeatureType(type: unknown): string {
	return compactJson(type);
}

function formatCell(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	return compactJson(value);
}

function compactJson(value: unknown): string {
	try {
		const rendered = JSON.stringify(value);
		return rendered === undefined ? String(value) : rendered;
	} catch {
		return String(value);
	}
}

function addCardValue(lines: string[], label: string, value: unknown): void {
	if (value === undefined || value === null) return;
	if (Array.isArray(value)) {
		const text = value.map((item) => String(item)).join(', ');
		if (text) lines.push(`- **${label}:** ${text}`);
		return;
	}
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		lines.push(`- **${label}:** ${String(value)}`);
	}
}

function formatErrorMessage(error: unknown): string {
	if (error instanceof HfApiError) {
		const detail = extractApiErrorDetail(error.responseBody);
		return detail
			? `${error.status.toString()} ${error.statusText}: ${detail}`
			: `${error.status.toString()} ${error.statusText}`;
	}
	if (error instanceof HubApiError) {
		return `${error.statusCode.toString()}: ${error.message}`;
	}
	return error instanceof Error ? error.message : String(error);
}

function extractApiErrorDetail(body: string | undefined): string | undefined {
	if (!body) return undefined;
	try {
		const parsed: unknown = JSON.parse(body);
		if (isRecord(parsed)) {
			return stringValue(parsed.error) ?? stringValue(parsed.cause_message) ?? stringValue(parsed.message);
		}
	} catch {
		return body.length > 200 ? `${body.slice(0, 200)}…` : body;
	}
	return undefined;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`Invalid ${label}: expected object`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDefined<T>(value: T | undefined): value is T {
	return value !== undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nullableNumberValue(value: unknown): number | null | undefined {
	return value === null ? null : numberValue(value);
}

function compareConfigSplit(a: { config: string; split: string }, b: { config: string; split: string }): number {
	return a.config.localeCompare(b.config) || a.split.localeCompare(b.split);
}

function compareSizeEntry(a: ViewerSizeEntry, b: ViewerSizeEntry): number {
	return (a.config ?? '').localeCompare(b.config ?? '') || (a.split ?? '').localeCompare(b.split ?? '');
}

function formatOptionalNumber(value: number | undefined | null): string {
	return value === undefined || value === null ? '—' : formatNumber(value);
}

function formatOptionalBytes(value: number | undefined | null): string {
	return value === undefined || value === null ? '—' : formatBytes(value);
}

function escapeTableCell(value: string): string {
	return escapeMarkdown(value);
}

function truncateMarkdown(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

function trimBlankLines(lines: string[]): string[] {
	const result = [...lines];
	while (result.length > 0 && result[0] === '') result.shift();
	while (result.length > 0 && result[result.length - 1] === '') result.pop();
	return result;
}
