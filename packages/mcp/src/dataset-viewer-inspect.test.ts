import { describe, expect, it } from 'vitest';
import { DatasetViewerInspector } from './dataset-viewer-inspect.js';

const squadSplits = {
	splits: [
		{ dataset: 'rajpurkar/squad', config: 'plain_text', split: 'validation' },
		{ dataset: 'rajpurkar/squad', config: 'plain_text', split: 'train' },
	],
	pending: [],
	failed: [],
};

const squadSize = {
	size: {
		dataset: {
			dataset: 'rajpurkar/squad',
			num_bytes_original_files: 16278203,
			num_bytes_parquet_files: 16278203,
			num_bytes_memory: 98346470,
			num_rows: 98169,
			estimated_num_rows: null,
		},
		configs: [
			{
				dataset: 'rajpurkar/squad',
				config: 'plain_text',
				num_bytes_original_files: 16278203,
				num_bytes_parquet_files: 16278203,
				num_bytes_memory: 98346470,
				num_rows: 98169,
				num_columns: 5,
				estimated_num_rows: null,
			},
		],
		splits: [
			{
				dataset: 'rajpurkar/squad',
				config: 'plain_text',
				split: 'train',
				num_bytes_parquet_files: 14458314,
				num_bytes_memory: 89338716,
				num_rows: 87599,
				num_columns: 5,
				estimated_num_rows: null,
			},
			{
				dataset: 'rajpurkar/squad',
				config: 'plain_text',
				split: 'validation',
				num_bytes_parquet_files: 1819889,
				num_bytes_memory: 9007754,
				num_rows: 10570,
				num_columns: 5,
				estimated_num_rows: null,
			},
		],
	},
	pending: [],
	failed: [],
	partial: false,
};

const squadParquet = {
	parquet_files: [
		{
			dataset: 'rajpurkar/squad',
			config: 'plain_text',
			split: 'train',
			url: 'https://huggingface.co/datasets/rajpurkar/squad/resolve/refs%2Fconvert%2Fparquet/plain_text/train/0000.parquet',
			filename: '0000.parquet',
			size: 14458314,
		},
		{
			dataset: 'rajpurkar/squad',
			config: 'plain_text',
			split: 'validation',
			url: 'https://huggingface.co/datasets/rajpurkar/squad/resolve/refs%2Fconvert%2Fparquet/plain_text/validation/0000.parquet',
			filename: '0000.parquet',
			size: 1819889,
		},
	],
	pending: [],
	failed: [],
	partial: false,
};

const squadRows = {
	features: [
		{ feature_idx: 0, name: 'id', type: { dtype: 'string', _type: 'Value' } },
		{ feature_idx: 1, name: 'context', type: { dtype: 'string', _type: 'Value' } },
		{
			feature_idx: 2,
			name: 'answers',
			type: {
				text: { feature: { dtype: 'string', _type: 'Value' }, _type: 'List' },
				answer_start: { feature: { dtype: 'int32', _type: 'Value' }, _type: 'List' },
			},
		},
	],
	rows: [
		{
			row_idx: 0,
			row: {
				id: '5733be284776f41900661182',
				context:
					'Architecturally, the school has a Catholic character. Atop the Main Building gold dome is a golden statue of the Virgin Mary.',
				answers: { text: ['Saint Bernadette Soubirous'], answer_start: [515] },
			},
			truncated_cells: [],
		},
	],
	num_rows_total: 87599,
	num_rows_per_page: 100,
	partial: false,
};

class SimulatedDatasetViewerClient {
	readonly calls: Array<{ path: string; params: Record<string, string | number | undefined> }> = [];

	constructor(private readonly responses: Record<string, unknown>) {}

	getJson<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
		this.calls.push({ path, params });
		const response = this.responses[path];
		if (response instanceof Error) return Promise.reject(response);
		return Promise.resolve(response as T);
	}
}

function createInspector(client: SimulatedDatasetViewerClient): DatasetViewerInspector {
	return new DatasetViewerInspector(undefined, {
		client,
		metadataProvider: {
			getMetadata() {
				return Promise.resolve({
					name: 'rajpurkar/squad',
					author: 'rajpurkar',
					downloadsAllTime: 123456,
					likes: 42,
					updatedAt: new Date('2025-01-02T00:00:00Z'),
					cardData: { license: 'cc-by-sa-4.0', task_categories: ['question-answering'] },
				});
			},
		},
	});
}

describe('DatasetViewerInspector', () => {
	it('formats structure from splits, size, parquet, and schema preview', async () => {
		const client = new SimulatedDatasetViewerClient({
			'/splits': squadSplits,
			'/size': squadSize,
			'/parquet': squadParquet,
			'/rows': squadRows,
		});
		const result = await createInspector(client).getStructure('rajpurkar/squad');

		expect(result).toContain('## Dataset Structure');
		expect(result).toContain('### Hub Metadata');
		expect(result).toContain('| plain\\_text | train | 87.6K | — | 5 | 14.5 MB |');
		expect(result).toContain('| plain\\_text | validation | 10.6K | — | 5 | 1.8 MB |');
		expect(result).toContain('### Parquet Exports');
		expect(result).toContain('| plain\\_text | train | 1 | 14.5 MB |');
		expect(result).toContain('Using `plain_text/train`.');
		expect(result).toContain('| 1 | id | {"dtype":"string","\\_type":"Value"} |');
		expect(result).toContain('| 3 | answers |');
	});

	it('requires config and split for multi-split previews', async () => {
		const client = new SimulatedDatasetViewerClient({
			'/splits': squadSplits,
		});
		const result = await createInspector(client).getPreview('rajpurkar/squad', {});

		expect(result).toContain('requires `config` and `split`');
		expect(result).toContain('- `plain_text` / `train`');
		expect(result).toContain('- `plain_text` / `validation`');
	});

	it('infers config and split for single-split previews and clamps limit', async () => {
		const client = new SimulatedDatasetViewerClient({
			'/splits': { splits: [{ dataset: 'x/y', config: 'default', split: 'train' }], pending: [], failed: [] },
			'/rows': squadRows,
		});
		const result = await createInspector(client).getPreview('x/y', { limit: 500 });

		expect(result).toContain('- Config: `default`');
		expect(result).toContain('- Split: `train`');
		expect(result).toContain('- Requested limit: `100`');
		expect(client.calls.find((call) => call.path === '/rows')?.params).toMatchObject({ length: 100 });
	});

	it('rejects negative offsets before fetching rows', async () => {
		const client = new SimulatedDatasetViewerClient({
			'/splits': squadSplits,
			'/rows': squadRows,
		});
		const result = await createInspector(client).getPreview('rajpurkar/squad', { offset: -1 });

		expect(result).toContain('`offset` must be a non-negative integer');
		expect(client.calls.some((call) => call.path === '/rows')).toBe(false);
	});

	it('surfaces Dataset Viewer endpoint failures as section warnings', async () => {
		const client = new SimulatedDatasetViewerClient({
			'/splits': new Error('The dataset has been renamed. Please use the current dataset name.'),
			'/size': new Error('The dataset has been renamed. Please use the current dataset name.'),
			'/parquet': new Error('The dataset has been renamed. Please use the current dataset name.'),
		});
		const result = await createInspector(client).getStructure('beans');

		expect(result).toContain('Could not fetch splits from Dataset Viewer');
		expect(result).toContain('Could not fetch size information from Dataset Viewer');
		expect(result).toContain('Could not fetch parquet export information from Dataset Viewer');
		expect(result).toContain('No config/split target was available for schema preview');
	});

	it('truncates row preview by cumulative output size rather than per-cell formatting', async () => {
		const client = new SimulatedDatasetViewerClient({
			'/splits': { splits: [{ dataset: 'x/y', config: 'default', split: 'train' }], pending: [], failed: [] },
			'/rows': {
				features: [{ feature_idx: 0, name: 'text', type: { dtype: 'string', _type: 'Value' } }],
				rows: [{ row_idx: 0, row: { text: 'x'.repeat(80_000) }, truncated_cells: [] }],
				num_rows_total: 1,
				num_rows_per_page: 100,
				partial: false,
			},
		});
		const result = await createInspector(client).getPreview('x/y', {});

		expect(result).toContain('Row preview output was truncated after approximately');
		expect(result.length).toBeLessThan(70_000);
	});
});
