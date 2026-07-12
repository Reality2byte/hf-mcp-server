import { HUB_URL, HubApiError, datasetInfo, modelInfo, spaceInfo } from '@huggingface/hub';
import picomatch from 'picomatch';

import { catGuidance, sliceUtf8, statGuidance } from './hf-fs-guidance.js';
import { safeFetch } from './network/safe-fetch.js';
import { createHuggingFaceHubPolicy } from './network/url-policy.js';
import type { HfFsCatResult, HfFsEntry, HfFsLsResult, HfFsParams, HfFsResult, HfFsStatResult } from './hf-fs.js';

const DAILY_PAPERS_LIMIT = 100;
const DEFAULT_ROOT_PAPER_SAMPLE_LIMIT = 10;
const PAPER_SEARCH_LIMIT = 120;
const DEFAULT_PAPER_SEARCH_LIMIT = 100;
const DEFAULT_CAT_MAX_BYTES = 20_000;
const MAX_CAT_BYTES = 80_000;
const DAILY_PAPERS_FIRST_DATE = '2023-05-04';
const DAILY_FEED_TIME_ZONE = 'America/New_York';

export type PaperLinkedKind = 'models' | 'datasets' | 'spaces';

export type ParsedPaperUri =
	| { kind: 'papers-root'; uri: 'hf://papers' }
	| { kind: 'papers-readme'; uri: 'hf://papers/README.md' }
	| { kind: 'papers-trending'; uri: 'hf://papers/trending' }
	| { kind: 'papers-daily-root'; uri: 'hf://papers/daily' }
	| { kind: 'papers-daily-latest'; uri: 'hf://papers/daily/latest' }
	| { kind: 'papers-daily-year'; uri: string; year: number }
	| { kind: 'papers-daily-month'; uri: string; year: number; month: number }
	| { kind: 'papers-daily-day'; uri: string; year: number; month: number; day: number; date: string }
	| { kind: 'paper'; uri: string; paperId: string; path: '' }
	| { kind: 'paper-file'; uri: string; paperId: string; path: 'metadata.json' | 'paper.md' }
	| { kind: 'paper-linked-root'; uri: string; paperId: string; target: PaperLinkedKind }
	| {
			kind: 'paper-linked-namespace';
			uri: string;
			paperId: string;
			target: PaperLinkedKind;
			namespace: string;
	  }
	| {
			kind: 'paper-linked-item';
			uri: string;
			paperId: string;
			target: PaperLinkedKind;
			namespace: string;
			name: string;
			remainder: string;
	  };

type TargetRunner = (params: HfFsParams) => Promise<HfFsResult>;
type PaperOrder = 'daily-batch' | 'trending';

const paperOrders = new WeakMap<HfFsLsResult, PaperOrder>();

export function paperListingOrder(result: HfFsLsResult): PaperOrder | undefined {
	return paperOrders.get(result);
}

interface PaperData extends Record<string, unknown> {
	id?: unknown;
	title?: unknown;
	summary?: unknown;
	ai_summary?: unknown;
	upvotes?: unknown;
	publishedAt?: unknown;
	submittedOnDailyAt?: unknown;
	authors?: unknown;
	projectPage?: unknown;
	githubRepo?: unknown;
	numTotalModels?: unknown;
	numTotalDatasets?: unknown;
	numTotalSpaces?: unknown;
}

interface LinkedRepoData extends Record<string, unknown> {
	id?: unknown;
	lastModified?: unknown;
	private?: unknown;
	downloads?: unknown;
	likes?: unknown;
	tags?: unknown;
	pipeline_tag?: unknown;
	library_name?: unknown;
	sdk?: unknown;
	trendingScore?: unknown;
}

interface LinkedRepos {
	models: LinkedRepoData[];
	datasets: LinkedRepoData[];
	spaces: LinkedRepoData[];
}

interface LinkedContext {
	paper: PaperData;
	repos: LinkedRepos;
}

interface LinkResolution {
	targetUri: string;
}

export function isPaperUri(uri: string): boolean {
	return uri === 'hf://papers' || uri.startsWith('hf://papers/');
}

export function parsePaperUri(uri: string): ParsedPaperUri {
	if (!isPaperUri(uri)) {
		throw new Error('EINVAL: URI must start with hf://papers');
	}
	let path = uri.slice('hf://'.length);
	if (path.includes('//')) {
		throw new Error('EINVAL: URI path must not contain empty segments');
	}
	path = path.replace(/\/+$/, '');
	if (path === 'papers') {
		return { kind: 'papers-root', uri: 'hf://papers' };
	}
	if (path === 'papers/README.md') {
		return { kind: 'papers-readme', uri: 'hf://papers/README.md' };
	}
	if (path === 'papers/trending') {
		return { kind: 'papers-trending', uri: 'hf://papers/trending' };
	}
	if (path === 'papers/daily') {
		return { kind: 'papers-daily-root', uri: 'hf://papers/daily' };
	}
	if (path === 'papers/daily/latest') {
		return { kind: 'papers-daily-latest', uri: 'hf://papers/daily/latest' };
	}

	const rawSegments = path.split('/').slice(1);
	const segments = rawSegments.map(decodeSegment);
	if (segments[0] === 'daily') {
		return parseDailyPaperUri(segments);
	}
	const rawPaperId = segments[0];
	if (!rawPaperId) {
		throw new Error('EINVAL: invalid arXiv paper id; expected an id such as 2502.16161 in hf://papers/2502.16161');
	}
	const paperId = normalizePaperId(rawPaperId);
	const paperUri = `hf://papers/${paperId}`;
	if (segments.length === 1) {
		return { kind: 'paper', uri: paperUri, paperId, path: '' };
	}

	const child = segments[1];
	if (segments.length === 2 && (child === 'metadata.json' || child === 'paper.md')) {
		return {
			kind: 'paper-file',
			uri: `${paperUri}/${child}`,
			paperId,
			path: child,
		};
	}
	if (!isLinkedKind(child)) {
		throw new Error('ENOENT: no such file or directory');
	}
	if (segments.length === 2) {
		return {
			kind: 'paper-linked-root',
			uri: `${paperUri}/${child}`,
			paperId,
			target: child,
		};
	}
	const namespace = requiredRepoSegment(segments[2]);
	if (segments.length === 3) {
		return {
			kind: 'paper-linked-namespace',
			uri: `${paperUri}/${child}/${encodeSegment(namespace)}`,
			paperId,
			target: child,
			namespace,
		};
	}
	const name = requiredRepoSegment(segments[3]);
	const remainder = segments.slice(4).join('/');
	return {
		kind: 'paper-linked-item',
		uri: `${paperUri}/${child}/${encodeSegment(namespace)}/${encodeSegment(name)}${
			remainder ? `/${encodePath(remainder)}` : ''
		}`,
		paperId,
		target: child,
		namespace,
		name,
		remainder,
	};
}

function parseDailyPaperUri(segments: string[]): ParsedPaperUri {
	const year = parseDateSegment(segments[1], 4, 'year');
	const yearUri = `hf://papers/daily/${year.toString().padStart(4, '0')}`;
	if (segments.length === 2) {
		return { kind: 'papers-daily-year', uri: yearUri, year };
	}
	const month = parseDateSegment(segments[2], 2, 'month');
	if (month < 1 || month > 12) {
		throw new Error('EINVAL: invalid Daily Papers month');
	}
	const monthUri = `${yearUri}/${month.toString().padStart(2, '0')}`;
	if (segments.length === 3) {
		return { kind: 'papers-daily-month', uri: monthUri, year, month };
	}
	const day = parseDateSegment(segments[3], 2, 'day');
	const date = `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
		.toString()
		.padStart(2, '0')}`;
	const parsedDate = new Date(`${date}T00:00:00.000Z`);
	if (
		segments.length !== 4 ||
		Number.isNaN(parsedDate.valueOf()) ||
		parsedDate.getUTCFullYear() !== year ||
		parsedDate.getUTCMonth() + 1 !== month ||
		parsedDate.getUTCDate() !== day
	) {
		throw new Error('EINVAL: invalid Daily Papers date');
	}
	return { kind: 'papers-daily-day', uri: `${monthUri}/${day.toString().padStart(2, '0')}`, year, month, day, date };
}

function parseDateSegment(value: string | undefined, width: number, name: string): number {
	if (!value || !new RegExp(`^\\d{${width.toString()}}$`).test(value)) {
		throw new Error(`EINVAL: invalid Daily Papers ${name}`);
	}
	return Number(value);
}

export class HfFsPaperProvider {
	private readonly accessToken?: string;
	private readonly hubUrl: string;
	private readonly targetRunner?: TargetRunner;
	private readonly paperCache = new Map<string, Promise<PaperData | undefined>>();
	private readonly reposCache = new Map<string, Promise<LinkedRepos>>();

	constructor(hfToken?: string, hubUrl?: string, targetRunner?: TargetRunner) {
		this.accessToken = hfToken;
		this.hubUrl = hubUrl ?? HUB_URL;
		this.targetRunner = targetRunner;
	}

	async run(params: HfFsParams): Promise<HfFsResult> {
		validatePaperParams(params);
		switch (params.op) {
			case 'ls':
				return await this.ls(params);
			case 'cat':
				return await this.cat(params);
			case 'stat':
				return await this.stat(params);
			case 'find':
				return await this.find(params);
			case 'search':
				return await this.search(params);
		}
	}

	async ls(params: HfFsParams): Promise<HfFsLsResult> {
		const parsed = parsePaperUri(params.uri);
		if (parsed.kind === 'papers-root') {
			return await this.listPapersRoot(params);
		}
		if (parsed.kind === 'papers-trending') {
			return await this.listTrendingPapers(params);
		}
		if (isDailyIndexUri(parsed)) {
			return await this.listDailyIndex(params, parsed);
		}
		if (parsed.kind === 'papers-readme' || parsed.kind === 'paper-file') {
			throw new Error('ENOTDIR: not a directory');
		}
		if (parsed.kind === 'paper-linked-item') {
			return (await this.forwardLink(params, parsed)) as HfFsLsResult;
		}
		if (params.recursive) {
			return await this.traverse(params, parsed, 'ls');
		}
		return await this.listPaperDirectory(params, parsed);
	}

	async cat(params: HfFsParams): Promise<HfFsCatResult> {
		const parsed = parsePaperUri(params.uri);
		const offset = params.offset ?? 0;
		const maxBytes = normalizedCatMaxBytes(params.max_bytes);
		if (parsed.kind === 'papers-readme') {
			return await catGuidance('papers', parsed.uri, 'README.md', offset, maxBytes);
		}
		if (parsed.kind === 'paper-file') {
			const paper = await this.getPaper(parsed.paperId);
			if (!paper) {
				throw new Error(
					`ENOENT: no such paper at hf://papers/${parsed.paperId}; verify the arXiv ID or use search hf://papers with query`
				);
			}
			const content =
				parsed.path === 'metadata.json'
					? `${JSON.stringify(paper, null, 2)}\n`
					: await this.getPaperMarkdown(parsed.paperId, paper);
			return textResult(
				parsed.uri,
				parsed.path,
				content,
				parsed.path === 'metadata.json' ? 'application/json' : 'text/markdown',
				offset,
				maxBytes
			);
		}
		if (parsed.kind === 'paper-linked-item') {
			return (await this.forwardLink(params, parsed)) as HfFsCatResult;
		}
		if (parsed.kind === 'paper') {
			throw new Error(
				`EISDIR: ${parsed.uri} is a paper directory; read ${parsed.uri}/paper.md or ${parsed.uri}/metadata.json`
			);
		}
		throw new Error('EISDIR: cat requires a file-like URI');
	}

	async stat(params: HfFsParams): Promise<HfFsStatResult> {
		const parsed = parsePaperUri(params.uri);
		if (parsed.kind === 'papers-root') {
			return { uri: parsed.uri, op: 'stat', exists: true, type: 'dir', path: 'papers' };
		}
		if (parsed.kind === 'papers-readme') {
			return await statGuidance('papers', parsed.uri, 'README.md');
		}
		if (parsed.kind === 'papers-trending' || isDailyIndexUri(parsed)) {
			return this.statPaperIndex(parsed);
		}
		const paper = await this.getPaper(parsed.paperId);
		if (!paper) {
			return {
				uri: parsed.uri,
				op: 'stat',
				exists: false,
				type: 'missing',
				path: parsed.kind === 'paper' ? parsed.paperId : paperPath(parsed),
			};
		}
		switch (parsed.kind) {
			case 'paper':
				return {
					uri: parsed.uri,
					op: 'stat',
					exists: true,
					type: 'paper',
					path: parsed.paperId,
					...paperWebMetadata(parsed.paperId, paper),
				};
			case 'paper-file':
				return {
					uri: parsed.uri,
					op: 'stat',
					exists: true,
					type: 'file',
					path: parsed.path,
					content_type: parsed.path === 'metadata.json' ? 'application/json' : 'text/markdown',
					...(parsed.path === 'metadata.json'
						? { size: new TextEncoder().encode(`${JSON.stringify(paper, null, 2)}\n`).byteLength }
						: {}),
				};
			case 'paper-linked-root':
				return { uri: parsed.uri, op: 'stat', exists: true, type: 'dir', path: parsed.target };
			case 'paper-linked-namespace': {
				const context = await this.linkedContext(parsed.paperId, paper);
				const exists = categoryEntries(context.repos, parsed.target).some(
					(entry) => repoParts(entry)?.namespace === parsed.namespace
				);
				return {
					uri: parsed.uri,
					op: 'stat',
					exists,
					type: exists ? 'dir' : 'missing',
					path: `${parsed.target}/${parsed.namespace}`,
				};
			}
			case 'paper-linked-item':
				if (parsed.remainder) {
					return (await this.forwardLink(params, parsed)) as HfFsStatResult;
				}
				return await this.statLink(parsed, paper);
		}
	}

	async find(params: HfFsParams): Promise<HfFsLsResult> {
		const parsed = parsePaperUri(params.uri);
		if (parsed.kind === 'papers-root') {
			throw new Error('ENOTSUP: find is not supported on hf://papers; use search hf://papers with query');
		}
		if (parsed.kind === 'papers-readme') {
			throw new Error('ENOTDIR: not a directory');
		}
		if (parsed.kind === 'papers-trending') {
			return await this.listTrendingPapers({ ...params, op: 'find' });
		}
		if (isDailyIndexUri(parsed)) {
			if (parsed.kind !== 'papers-daily-day' && parsed.kind !== 'papers-daily-latest') {
				throw new Error('ENOTSUP: find on Daily Papers must be scoped to a day or daily/latest');
			}
			return await this.listDailyIndex({ ...params, op: 'find' }, parsed);
		}
		if (parsed.kind === 'paper-linked-item') {
			return (await this.forwardLink(params, parsed)) as HfFsLsResult;
		}
		if (parsed.kind === 'paper-file') {
			const stat = await this.stat(params);
			const entry = stat.exists ? statToEntry(stat) : undefined;
			return {
				uri: parsed.uri,
				op: 'find',
				entries: entry && matchesFind(entry, params, parsed.path) ? [entry] : [],
			};
		}
		return await this.traverse(params, parsed, 'find');
	}

	async search(params: HfFsParams): Promise<HfFsLsResult> {
		const parsed = parsePaperUri(params.uri);
		if (parsed.kind === 'papers-readme') {
			throw new Error('ENOTDIR: not a directory');
		}
		if (parsed.kind !== 'papers-root') {
			throw new Error(
				'ENOTSUP: paper search is supported only on hf://papers; retry with the same query and uri="hf://papers"'
			);
		}
		const query = params.query?.trim();
		if (!query) {
			throw new Error('EINVAL: search requires query');
		}
		const url = new URL('/api/papers/search', this.hubUrl);
		url.searchParams.set('q', query);
		const response = await this.fetch(url, 'application/json');
		await assertOk(response, 'paper search');
		const body: unknown = await response.json();
		const allEntries = Array.isArray(body) ? body.flatMap((item) => paperEntry(item)) : [];
		const requestedLimit = params.limit ?? DEFAULT_PAPER_SEARCH_LIMIT;
		const limit = Math.min(requestedLimit, PAPER_SEARCH_LIMIT);
		const filtered = allEntries.filter(entryFilter(params));
		const entries = filtered.slice(0, limit);
		const limitTruncated = filtered.length > limit;
		const providerTruncated = requestedLimit > PAPER_SEARCH_LIMIT && allEntries.length >= PAPER_SEARCH_LIMIT;
		return {
			uri: parsed.uri,
			op: 'search',
			entries,
			...(limitTruncated || providerTruncated
				? {
						truncated: true,
						truncation_reason: limitTruncated ? ('limit' as const) : ('provider_limit' as const),
					}
				: {}),
		};
	}

	private async listPapersRoot(params: HfFsParams): Promise<HfFsLsResult> {
		if (params.sort !== undefined) {
			throw new Error('EINVAL: sort is not supported on hf://papers; list hf://papers/trending instead');
		}
		if (params.recursive) {
			throw new Error(
				'ENOTSUP: recursive ls is not supported on hf://papers; use search hf://papers with query, ls hf://papers/trending, or ls hf://papers/daily/latest'
			);
		}
		const structuralEntries: HfFsEntry[] = [
			{
				type: 'file',
				name: 'README.md',
				path: 'README.md',
				uri: 'hf://papers/README.md',
				title: 'How to use Hugging Face Papers',
				description:
					'Search globally or inspect a paper directly as hf://papers/ARXIV_ID, for example hf://papers/2502.16161/paper.md.',
				content_type: 'text/markdown',
			},
			{
				...directoryEntry('daily', 'hf://papers/daily'),
				description: 'Browse Daily Papers batches from 2023-05-04, including daily/latest.',
			},
			{
				...directoryEntry('trending', 'hf://papers/trending'),
				description: 'Current opaque Hugging Face global trending ranking.',
			},
		];
		const sampleLimit = Math.min(params.limit ?? DEFAULT_ROOT_PAPER_SAMPLE_LIMIT, DAILY_PAPERS_LIMIT);
		const url = new URL('/api/daily_papers', this.hubUrl);
		url.searchParams.set('p', '0');
		url.searchParams.set('limit', sampleLimit.toString());
		url.searchParams.set('sort', 'publishedAt');
		const response = await this.fetch(url, 'application/json');
		await assertOk(response, 'recent paper sample');
		const body: unknown = await response.json();
		const paperEntries = Array.isArray(body) ? body.flatMap((item) => paperEntry(item)).slice(0, sampleLimit) : [];
		const entries = [...structuralEntries.filter(entryFilter(params)), ...filterPaperEntries(paperEntries, params)];
		const includesPaperNamespace = params.entry_type === undefined || params.entry_type === 'paper';
		return {
			uri: 'hf://papers',
			op: 'ls',
			entries,
			...(includesPaperNamespace
				? {
						truncated: true,
						truncation_reason: 'provider_limit' as const,
						truncation_message: `Showing ${paperEntries.length.toString()} recent papers. The complete paper namespace is not enumerable; use search hf://papers to discover papers by topic or inspect hf://papers/ARXIV_ID directly.`,
					}
				: {}),
		};
	}

	private async listTrendingPapers(params: HfFsParams): Promise<HfFsLsResult> {
		if (params.sort !== undefined && params.sort !== 'trending') {
			throw new Error('EINVAL: hf://papers/trending does not accept another sort');
		}
		const limit = Math.min(params.limit ?? DAILY_PAPERS_LIMIT, DAILY_PAPERS_LIMIT);
		const url = new URL('/api/daily_papers', this.hubUrl);
		url.searchParams.set('p', '0');
		url.searchParams.set('limit', limit.toString());
		url.searchParams.set('sort', 'trending');
		const response = await this.fetch(url, 'application/json');
		await assertOk(response, 'trending papers');
		const body: unknown = await response.json();
		const observedAt = new Date().toISOString();
		const papers = Array.isArray(body)
			? body.flatMap((item) => paperEntry(item)).map((entry) => ({ ...entry, observed_at: observedAt }))
			: [];
		const result: HfFsLsResult = {
			uri: params.uri,
			op: params.op === 'find' ? 'find' : 'ls',
			entries: filterPaperEntries(papers, params).slice(0, limit),
			...(hasNextLink(response.headers.get('link')) ? { truncated: true, truncation_reason: 'limit' as const } : {}),
		};
		paperOrders.set(result, 'trending');
		return result;
	}

	private async listDailyIndex(
		params: HfFsParams,
		parsed: Extract<
			ParsedPaperUri,
			| { kind: 'papers-daily-root' }
			| { kind: 'papers-daily-latest' }
			| { kind: 'papers-daily-year' }
			| { kind: 'papers-daily-month' }
			| { kind: 'papers-daily-day' }
		>
	): Promise<HfFsLsResult> {
		if (params.sort !== undefined) {
			throw new Error('EINVAL: dated Daily Papers listings use upstream batch upvote order and do not accept sort');
		}
		const latest = currentDailyFeedDate();
		if (parsed.kind === 'papers-daily-day' || parsed.kind === 'papers-daily-latest') {
			const date = parsed.kind === 'papers-daily-day' ? parsed.date : latest;
			if (date < DAILY_PAPERS_FIRST_DATE) {
				throw new Error('ENOENT: Daily Papers date predates the archive');
			}
			if (date > latest) {
				throw new Error(
					`ENOENT: Daily Papers for ${date} are not available yet; latest available date is ${latest}; use ls hf://papers/daily/latest`
				);
			}
			const limit = Math.min(params.limit ?? DAILY_PAPERS_LIMIT, DAILY_PAPERS_LIMIT);
			const url = new URL('/api/daily_papers', this.hubUrl);
			url.searchParams.set('p', '0');
			url.searchParams.set('limit', limit.toString());
			url.searchParams.set('date', date);
			url.searchParams.set('sort', 'publishedAt');
			const response = await this.fetch(url, 'application/json');
			await assertOk(response, 'dated Daily Papers');
			const body: unknown = await response.json();
			const entries = Array.isArray(body)
				? filterPaperEntries(
						body.flatMap((item) => paperEntry(item)),
						params
					)
				: [];
			const result: HfFsLsResult = {
				uri: parsed.uri,
				op: params.op === 'find' ? 'find' : 'ls',
				entries: entries.slice(0, limit),
				...(hasNextLink(response.headers.get('link')) ? { truncated: true, truncation_reason: 'limit' as const } : {}),
			};
			paperOrders.set(result, 'daily-batch');
			return result;
		}

		const [latestYear, latestMonth, latestDay] = latest.split('-').map(Number) as [number, number, number];
		let entries: HfFsEntry[];
		if (parsed.kind === 'papers-daily-root') {
			const firstYear = Number(DAILY_PAPERS_FIRST_DATE.slice(0, 4));
			entries = [
				{
					...directoryEntry('latest', 'hf://papers/daily/latest'),
					target_uri: dailyPapersUri(latest),
					daily_papers_date: latest,
					description: `Alias for the current Daily Papers batch at ${dailyPapersUri(latest)}.`,
				},
				...Array.from({ length: latestYear - firstYear + 1 }, (_, index) => {
					const year = firstYear + index;
					return directoryEntry(year.toString(), `hf://papers/daily/${year.toString()}`);
				}),
			];
		} else if (parsed.kind === 'papers-daily-year') {
			const firstYear = Number(DAILY_PAPERS_FIRST_DATE.slice(0, 4));
			if (parsed.year < firstYear || parsed.year > latestYear) {
				throw new Error('ENOENT: Daily Papers year does not exist');
			}
			const firstMonth = parsed.year === firstYear ? Number(DAILY_PAPERS_FIRST_DATE.slice(5, 7)) : 1;
			const lastMonth = parsed.year === latestYear ? latestMonth : 12;
			entries = Array.from({ length: lastMonth - firstMonth + 1 }, (_, index) => {
				const month = (firstMonth + index).toString().padStart(2, '0');
				return directoryEntry(month, `${parsed.uri}/${month}`);
			});
		} else {
			if (
				`${parsed.year.toString().padStart(4, '0')}-${parsed.month.toString().padStart(2, '0')}` <
					DAILY_PAPERS_FIRST_DATE.slice(0, 7) ||
				parsed.year > latestYear ||
				(parsed.year === latestYear && parsed.month > latestMonth)
			) {
				throw new Error('ENOENT: Daily Papers month does not exist');
			}
			const days = daysInMonth(parsed.year, parsed.month);
			const firstDay =
				parsed.year === Number(DAILY_PAPERS_FIRST_DATE.slice(0, 4)) &&
				parsed.month === Number(DAILY_PAPERS_FIRST_DATE.slice(5, 7))
					? Number(DAILY_PAPERS_FIRST_DATE.slice(8, 10))
					: 1;
			const lastDay = parsed.year === latestYear && parsed.month === latestMonth ? latestDay : days;
			entries = Array.from({ length: lastDay - firstDay + 1 }, (_, index) => {
				const day = (firstDay + index).toString().padStart(2, '0');
				return directoryEntry(day, `${parsed.uri}/${day}`);
			});
		}
		return {
			uri: parsed.uri,
			op: 'ls',
			entries: filterPaperEntries(entries, params).slice(0, params.limit ?? entries.length),
		};
	}

	private statPaperIndex(
		parsed: Extract<
			ParsedPaperUri,
			| { kind: 'papers-trending' }
			| { kind: 'papers-daily-root' }
			| { kind: 'papers-daily-latest' }
			| { kind: 'papers-daily-year' }
			| { kind: 'papers-daily-month' }
			| { kind: 'papers-daily-day' }
		>
	): HfFsStatResult {
		const latest = currentDailyFeedDate();
		const latestPath = latest.replaceAll('-', '/');
		const indexedPath =
			parsed.kind === 'papers-daily-year'
				? parsed.year.toString()
				: parsed.kind === 'papers-daily-month'
					? `${parsed.year.toString()}/${parsed.month.toString().padStart(2, '0')}`
					: parsed.kind === 'papers-daily-day'
						? `${parsed.year.toString()}/${parsed.month.toString().padStart(2, '0')}/${parsed.day
								.toString()
								.padStart(2, '0')}`
						: undefined;
		const exists =
			indexedPath === undefined ||
			(indexedPath >= DAILY_PAPERS_FIRST_DATE.replaceAll('-', '/').slice(0, indexedPath.length) &&
				indexedPath <= latestPath);
		const target = parsed.kind === 'papers-daily-latest' ? `hf://papers/daily/${latestPath}` : undefined;
		return {
			uri: parsed.uri,
			op: 'stat',
			exists,
			type: exists ? 'dir' : 'missing',
			path: parsed.uri.slice('hf://papers/'.length),
			...(target ? { target_uri: target, daily_papers_date: latest } : {}),
		};
	}

	private async listPaperDirectory(params: HfFsParams, parsed: CanonicalPaperDirectoryUri): Promise<HfFsLsResult> {
		const paper = await this.getPaper(parsed.paperId);
		if (!paper) {
			throw new Error('ENOENT: no such paper');
		}
		let entries: HfFsEntry[];
		let providerTruncated = false;
		switch (parsed.kind) {
			case 'paper':
				entries = paperChildren(parsed.uri);
				break;
			case 'paper-linked-root': {
				const context = await this.linkedContext(parsed.paperId, paper);
				entries = namespaceEntries(parsed.paperId, parsed.target, context.repos);
				providerTruncated = categoryTruncated(context, parsed.target);
				break;
			}
			case 'paper-linked-namespace': {
				const context = await this.linkedContext(parsed.paperId, paper);
				entries = linkEntries(parsed.paperId, parsed.target, context.repos).filter(
					(entry) => repoPartsFromPath(entry.path)?.namespace === parsed.namespace
				);
				if (!entries.length) {
					throw new Error('ENOENT: no such file or directory');
				}
				providerTruncated = categoryTruncated(context, parsed.target);
				break;
			}
		}
		const matcher = params.glob ? picomatch(params.glob, { dot: true }) : undefined;
		const base = paperPath(parsed);
		const filtered = entries.filter(
			(entry) => entryFilter(params)(entry) && (!matcher || matcher(relativePath(base, entry.path)))
		);
		const limit = params.limit ?? filtered.length;
		const limited = filtered.slice(0, limit);
		const entryTruncated = filtered.length > limit;
		return {
			uri: parsed.uri,
			op: 'ls',
			entries: limited,
			...(entryTruncated || providerTruncated
				? {
						truncated: true,
						truncation_reason: entryTruncated ? ('entry_limit' as const) : ('provider_limit' as const),
					}
				: {}),
		};
	}

	private async traverse(
		params: HfFsParams,
		parsed: CanonicalPaperDirectoryUri,
		op: 'ls' | 'find'
	): Promise<HfFsLsResult> {
		const paper = await this.getPaper(parsed.paperId);
		if (!paper) {
			throw new Error('ENOENT: no such paper');
		}
		const context = await this.linkedContext(parsed.paperId, paper);
		const all = traversalEntries(parsed.paperId, context.repos);
		const base = paperPath(parsed);
		const descendants = all.filter((entry) => isDescendant(entry.path, base));
		const matcher = params.glob ? picomatch(params.glob, { dot: true }) : undefined;
		const filtered = descendants.filter((entry) => {
			const relative = relativePath(base, entry.path);
			if (op === 'ls') {
				return entryFilter(params)(entry) && (!matcher || matcher(relative));
			}
			return matchesFind(entry, params, relative);
		});
		const limit = params.limit ?? filtered.length;
		const entries = filtered.slice(0, limit);
		const entryTruncated = filtered.length > limit;
		const targets =
			parsed.kind === 'paper'
				? (['models', 'datasets', 'spaces'] as const)
				: ([parsed.target] as readonly PaperLinkedKind[]);
		const providerTruncated = targets.some((target) => categoryTruncated(context, target));
		return {
			uri: parsed.uri,
			op,
			entries,
			...(entryTruncated || providerTruncated
				? {
						truncated: true,
						truncation_reason: entryTruncated ? ('entry_limit' as const) : ('provider_limit' as const),
					}
				: {}),
		};
	}

	private async statLink(
		parsed: Extract<ParsedPaperUri, { kind: 'paper-linked-item' }>,
		paper: PaperData
	): Promise<HfFsStatResult> {
		const resolution = await this.resolveLink(parsed, paper);
		return {
			uri: parsed.uri,
			op: 'stat',
			exists: true,
			type: 'link',
			path: paperPath(parsed),
			target_uri: resolution.targetUri,
		};
	}

	private async forwardLink(
		params: HfFsParams,
		parsed: Extract<ParsedPaperUri, { kind: 'paper-linked-item' }>
	): Promise<HfFsResult> {
		const paper = await this.getPaper(parsed.paperId);
		if (!paper) {
			throw new Error('ENOENT: no such paper');
		}
		const resolution = await this.resolveLink(parsed, paper);
		if (!this.targetRunner) {
			throw new Error(`ENOTSUP: linked target resolution is unavailable; use ${resolution.targetUri}`);
		}
		return await this.targetRunner({
			...params,
			uri: `${resolution.targetUri}${parsed.remainder ? `/${encodePath(parsed.remainder)}` : ''}`,
		});
	}

	private async resolveLink(
		parsed: Extract<ParsedPaperUri, { kind: 'paper-linked-item' }>,
		paper: PaperData
	): Promise<LinkResolution> {
		const targetUri = `hf://${parsed.target}/${encodeSegment(parsed.namespace)}/${encodeSegment(parsed.name)}`;
		const context = await this.linkedContext(parsed.paperId, paper);
		const entry = linkEntries(parsed.paperId, parsed.target, context.repos).find(
			(candidate) => candidate.target_uri === targetUri
		);
		if (entry) {
			return { targetUri };
		}
		if (!categoryTruncated(context, parsed.target)) {
			throw new Error('ENOENT: linked repository not found for this paper');
		}
		const verification = await this.verifyDirectRelationship(parsed, `${parsed.namespace}/${parsed.name}`);
		if (verification === 'verified') {
			return { targetUri };
		}
		if (verification === 'missing') {
			throw new Error('ENOENT: linked repository not found for this paper');
		}
		throw new Error(`ENOTSUP: linked relationship is outside the bounded paper result; use ${targetUri}`);
	}

	private async verifyDirectRelationship(
		parsed: Extract<ParsedPaperUri, { kind: 'paper-linked-item' }>,
		repoId: string
	): Promise<'verified' | 'missing' | 'unknown'> {
		try {
			const common = {
				name: repoId,
				...(this.hubUrl ? { hubUrl: this.hubUrl } : {}),
				...(this.accessToken ? { accessToken: this.accessToken } : {}),
				fetch: this.safeHubFetch,
			};
			const info =
				parsed.target === 'models'
					? await modelInfo({ ...common, additionalFields: ['tags'] })
					: parsed.target === 'datasets'
						? await datasetInfo({ ...common, additionalFields: ['tags'] })
						: await spaceInfo({ ...common, additionalFields: ['tags'] });
			const tags = info.tags;
			return tags.some((tag) => tag.toLowerCase() === `arxiv:${parsed.paperId}`.toLowerCase()) ? 'verified' : 'unknown';
		} catch (error) {
			if (error instanceof HubApiError && error.statusCode === 404) {
				return 'missing';
			}
			return 'unknown';
		}
	}

	private async linkedContext(paperId: string, paper?: PaperData): Promise<LinkedContext> {
		const resolvedPaper = paper ?? (await this.getPaper(paperId));
		if (!resolvedPaper) {
			throw new Error('ENOENT: no such paper');
		}
		return { paper: resolvedPaper, repos: await this.getLinkedRepos(paperId) };
	}

	private async getPaper(paperId: string): Promise<PaperData | undefined> {
		const cached = this.paperCache.get(paperId);
		if (cached) {
			return await cached;
		}
		const promise = this.fetchPaper(paperId);
		this.paperCache.set(paperId, promise);
		try {
			return await promise;
		} catch (error) {
			this.paperCache.delete(paperId);
			throw error;
		}
	}

	private async fetchPaper(paperId: string): Promise<PaperData | undefined> {
		const response = await this.fetch(
			new URL(`/api/papers/${encodeURIComponent(paperId)}`, this.hubUrl),
			'application/json'
		);
		if (response.status === 404) {
			return undefined;
		}
		await assertOk(response, 'paper metadata');
		const body: unknown = await response.json();
		return isRecord(body) ? body : {};
	}

	private async getLinkedRepos(paperId: string): Promise<LinkedRepos> {
		const cached = this.reposCache.get(paperId);
		if (cached) {
			return await cached;
		}
		const promise = this.fetchLinkedRepos(paperId);
		this.reposCache.set(paperId, promise);
		try {
			return await promise;
		} catch (error) {
			this.reposCache.delete(paperId);
			throw error;
		}
	}

	private async fetchLinkedRepos(paperId: string): Promise<LinkedRepos> {
		const response = await this.fetch(
			new URL(`/api/arxiv/${encodeURIComponent(paperId)}/repos`, this.hubUrl),
			'application/json'
		);
		await assertOk(response, 'paper linked repositories');
		const body: unknown = await response.json();
		return {
			models: recordArray(body, 'models'),
			datasets: recordArray(body, 'datasets'),
			spaces: recordArray(body, 'spaces'),
		};
	}

	private async getPaperMarkdown(paperId: string, paper: PaperData): Promise<string> {
		const response = await this.fetch(
			new URL(`/papers/${encodeURIComponent(paperId)}.md`, this.hubUrl),
			'text/markdown'
		);
		if (response.ok) {
			return await response.text();
		}
		return fallbackMarkdown(paperId, paper, this.hubUrl);
	}

	private async fetch(url: URL, accept: string): Promise<Response> {
		const { response } = await safeFetch(url.toString(), {
			urlPolicy: createHuggingFaceHubPolicy(),
			requestInit: {
				headers: {
					accept,
					...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
				},
			},
		});
		return response;
	}

	private readonly safeHubFetch: typeof fetch = async (url, requestInit) => {
		const safeUrl = typeof url === 'string' || url instanceof URL ? url : url.url;
		const { response } = await safeFetch(safeUrl, {
			urlPolicy: createHuggingFaceHubPolicy(),
			requestInit,
		});
		return response;
	};
}

function normalizePaperId(value: string): string {
	const match = /^(\d{4})\.(\d{3,5})$/.exec(value);
	if (!match) {
		throw new Error('EINVAL: invalid arXiv paper id; expected an id such as 2502.16161 in hf://papers/2502.16161');
	}
	const prefix = match[1] ?? '';
	const suffix = match[2] ?? '';
	return `${prefix}.${suffix.length === 3 ? suffix.padStart(5, '0') : suffix}`;
}

function decodeSegment(segment: string): string {
	try {
		return decodeURIComponent(segment);
	} catch {
		throw new Error('EINVAL: invalid percent-encoding in URI segment');
	}
}

function requiredRepoSegment(value: string | undefined): string {
	if (!value || value.includes('/')) {
		throw new Error('EINVAL: invalid linked repository path');
	}
	return value;
}

function encodeSegment(value: string): string {
	return encodeURIComponent(value);
}

function encodePath(value: string): string {
	return value.split('/').map(encodeSegment).join('/');
}

function isLinkedKind(value: string | undefined): value is PaperLinkedKind {
	return value === 'models' || value === 'datasets' || value === 'spaces';
}

function paperEntry(value: unknown): HfFsEntry[] {
	if (!isRecord(value)) {
		return [];
	}
	const wrapped = isRecord(value.paper) ? value.paper : value;
	const id = stringValue(wrapped.id);
	if (!id) {
		return [];
	}
	let paperId: string;
	try {
		paperId = normalizePaperId(id);
	} catch {
		return [];
	}
	const title = stringValue(wrapped.title) ?? stringValue(value.title);
	const description = stringValue(wrapped.ai_summary) ?? stringValue(wrapped.summary) ?? stringValue(value.summary);
	const publishedAt = stringValue(wrapped.publishedAt) ?? stringValue(value.publishedAt);
	const dailyPapersDate = dailyPapersDateFromPaper(wrapped);
	return [
		compactEntry({
			type: 'paper',
			name: paperId,
			path: paperId,
			uri: `hf://papers/${paperId}`,
			title,
			description,
			upvotes: numberValue(wrapped.upvotes),
			created_at: publishedAt,
			published_at: publishedAt,
			...(dailyPapersDate
				? {
						daily_papers_date: dailyPapersDate,
						daily_papers_uri: dailyPapersUri(dailyPapersDate),
					}
				: {}),
			url: paperWebUrl(paperId),
			arxiv_url: arxivUrl(paperId),
		}),
	];
}

function paperChildren(paperUri: string): HfFsEntry[] {
	return [
		{
			type: 'file',
			name: 'metadata.json',
			path: 'metadata.json',
			uri: `${paperUri}/metadata.json`,
			content_type: 'application/json',
		},
		{
			type: 'file',
			name: 'paper.md',
			path: 'paper.md',
			uri: `${paperUri}/paper.md`,
			content_type: 'text/markdown',
		},
		{ type: 'dir', name: 'models', path: 'models', uri: `${paperUri}/models` },
		{ type: 'dir', name: 'datasets', path: 'datasets', uri: `${paperUri}/datasets` },
		{ type: 'dir', name: 'spaces', path: 'spaces', uri: `${paperUri}/spaces` },
	];
}

function namespaceEntries(paperId: string, target: PaperLinkedKind, repos: LinkedRepos): HfFsEntry[] {
	const namespaces = new Set<string>();
	for (const repo of categoryEntries(repos, target)) {
		const parts = repoParts(repo);
		if (parts) {
			namespaces.add(parts.namespace);
		}
	}
	return [...namespaces].sort(caseInsensitiveCompare).map((namespace) => ({
		type: 'dir',
		name: namespace,
		path: `${target}/${namespace}`,
		uri: `hf://papers/${paperId}/${target}/${encodeSegment(namespace)}`,
	}));
}

function linkEntries(paperId: string, target: PaperLinkedKind, repos: LinkedRepos): HfFsEntry[] {
	return categoryEntries(repos, target)
		.flatMap((repo) => {
			const parts = repoParts(repo);
			if (!parts) {
				return [];
			}
			const path = `${target}/${parts.namespace}/${parts.name}`;
			return [
				compactEntry({
					type: 'link',
					name: parts.name,
					path,
					uri: `hf://papers/${paperId}/${target}/${encodeSegment(parts.namespace)}/${encodeSegment(parts.name)}`,
					target_uri: `hf://${target}/${encodeSegment(parts.namespace)}/${encodeSegment(parts.name)}`,
					title: `${parts.namespace}/${parts.name}`,
					private: booleanValue(repo.private),
					likes: numberValue(repo.likes),
					...(target === 'spaces' ? {} : { downloads: numberValue(repo.downloads) }),
					task: target === 'models' ? stringValue(repo.pipeline_tag) : undefined,
					library: target === 'models' ? stringValue(repo.library_name) : undefined,
					sdk: target === 'spaces' ? stringValue(repo.sdk) : undefined,
					tags: stringArray(repo.tags),
					trending_score: target === 'spaces' ? numberValue(repo.trendingScore) : undefined,
					updated_at: stringValue(repo.lastModified),
				}),
			];
		})
		.sort((left, right) => {
			const leftParts = repoPartsFromPath(left.path);
			const rightParts = repoPartsFromPath(right.path);
			return (
				caseInsensitiveCompare(leftParts?.namespace ?? '', rightParts?.namespace ?? '') ||
				caseInsensitiveCompare(left.name ?? '', right.name ?? '')
			);
		});
}

function traversalEntries(paperId: string, repos: LinkedRepos): HfFsEntry[] {
	const paperUri = `hf://papers/${paperId}`;
	const children = paperChildren(paperUri);
	const entries = children.slice(0, 2);
	for (const target of ['models', 'datasets', 'spaces'] as const) {
		const root = children.find((entry) => entry.path === target);
		if (root) {
			entries.push(root);
		}
		entries.push(...namespaceEntries(paperId, target, repos), ...linkEntries(paperId, target, repos));
	}
	return entries;
}

function categoryEntries(repos: LinkedRepos, target: PaperLinkedKind): LinkedRepoData[] {
	return repos[target];
}

function categoryTruncated(context: LinkedContext, target: PaperLinkedKind): boolean {
	const totalKey =
		target === 'models' ? 'numTotalModels' : target === 'datasets' ? 'numTotalDatasets' : 'numTotalSpaces';
	const total = numberValue(context.paper[totalKey]);
	return total !== undefined && total > context.repos[target].length;
}

function repoParts(repo: LinkedRepoData): { namespace: string; name: string } | undefined {
	const id = stringValue(repo.id);
	if (!id) {
		return undefined;
	}
	const slash = id.indexOf('/');
	if (slash <= 0 || slash === id.length - 1 || id.indexOf('/', slash + 1) !== -1) {
		return undefined;
	}
	return { namespace: id.slice(0, slash), name: id.slice(slash + 1) };
}

function repoPartsFromPath(path: string): { namespace: string; name: string } | undefined {
	const [, namespace, name] = path.split('/');
	return namespace && name ? { namespace, name } : undefined;
}

function paperPath(parsed: PaperPathUri): string {
	switch (parsed.kind) {
		case 'paper':
			return '';
		case 'paper-file':
			return parsed.path;
		case 'paper-linked-root':
			return parsed.target;
		case 'paper-linked-namespace':
			return `${parsed.target}/${parsed.namespace}`;
		case 'paper-linked-item':
			return `${parsed.target}/${parsed.namespace}/${parsed.name}${parsed.remainder ? `/${parsed.remainder}` : ''}`;
	}
}

function fallbackMarkdown(paperId: string, paper: PaperData, hubUrl: string): string {
	const title = stringValue(paper.title) ?? paperId;
	const authors = Array.isArray(paper.authors)
		? paper.authors.flatMap((author) => {
				if (!isRecord(author) || author.hidden === true) {
					return [];
				}
				const name = stringValue(author.name);
				return name ? [name] : [];
			})
		: [];
	const publishedAt = stringValue(paper.publishedAt);
	const dailyPapersDate = dailyPapersDateFromPaper(paper);
	const projectPage = stringValue(paper.projectPage);
	const githubRepo = stringValue(paper.githubRepo);
	const aiSummary = stringValue(paper.ai_summary);
	const summary = stringValue(paper.summary);
	const lines = [
		`# ${title}`,
		'',
		'> **Full-text availability:** The full paper is not available in Markdown.',
		'> This fallback document contains metadata and summaries. Read the',
		`> [original PDF](https://arxiv.org/pdf/${paperId}).`,
		'',
		...(authors.length ? [`**Authors:** ${authors.join(', ')}`] : []),
		...(publishedAt ? [`**Published:** ${publishedAt}`] : []),
		`**arXiv:** ${paperId}`,
		'',
		'## Links',
		'',
		`- [Hugging Face paper page](${new URL(`/papers/${paperId}`, hubUrl).toString()})`,
		`- [arXiv abstract](https://arxiv.org/abs/${paperId})`,
		`- [Original PDF](https://arxiv.org/pdf/${paperId})`,
		...(dailyPapersDate ? [`- Daily Papers cohort: \`${dailyPapersUri(dailyPapersDate)}\``] : []),
		...(projectPage ? [`- [Project page](${projectPage})`] : []),
		...(githubRepo ? [`- [GitHub repository](${githubRepo})`] : []),
		...(aiSummary
			? [
					'',
					'## AI-generated summary',
					'',
					'> This section was generated by an AI model and may contain inaccuracies.',
					'',
					aiSummary,
				]
			: []),
		...(summary ? ['', '## Abstract', '', summary] : []),
	];
	return `${lines.join('\n')}\n`;
}

function textResult(
	uri: string,
	path: string,
	content: string,
	contentType: 'application/json' | 'text/markdown',
	offset: number,
	maxBytes: number
): HfFsCatResult {
	const range = sliceUtf8(content, offset, maxBytes);
	return {
		uri,
		op: 'cat',
		path,
		content: range.content,
		content_type: contentType,
		bytes: range.bytes,
		truncated: range.truncated,
		...(range.truncated ? { truncation_reason: 'max_bytes', next_offset: range.nextOffset } : {}),
	};
}

function normalizedCatMaxBytes(value: number | undefined): number {
	return value === undefined ? DEFAULT_CAT_MAX_BYTES : value === 0 ? MAX_CAT_BYTES : value;
}

type DailyIndexUri = Extract<
	ParsedPaperUri,
	| { kind: 'papers-daily-root' }
	| { kind: 'papers-daily-latest' }
	| { kind: 'papers-daily-year' }
	| { kind: 'papers-daily-month' }
	| { kind: 'papers-daily-day' }
>;
type CanonicalPaperDirectoryUri = Extract<
	ParsedPaperUri,
	{ kind: 'paper' } | { kind: 'paper-linked-root' } | { kind: 'paper-linked-namespace' }
>;
type PaperPathUri = Extract<
	ParsedPaperUri,
	| { kind: 'paper' }
	| { kind: 'paper-file' }
	| { kind: 'paper-linked-root' }
	| { kind: 'paper-linked-namespace' }
	| { kind: 'paper-linked-item' }
>;

function isDailyIndexUri(parsed: ParsedPaperUri): parsed is DailyIndexUri {
	return parsed.kind.startsWith('papers-daily-');
}

function directoryEntry(name: string, uri: string): HfFsEntry {
	return { type: 'dir', name, path: name, uri };
}

function filterPaperEntries(entries: HfFsEntry[], params: HfFsParams): HfFsEntry[] {
	const matcher = params.glob ? picomatch(params.glob, { dot: true }) : undefined;
	return entries.filter((entry) => {
		if (params.op === 'find') {
			return matchesFind(entry, params, entry.path);
		}
		return entryFilter(params)(entry) && (!matcher || matcher(entry.path));
	});
}

function currentDailyFeedDate(now = new Date()): string {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: DAILY_FEED_TIME_ZONE,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	})
		.formatToParts(now)
		.reduce<Record<string, string>>((result, part) => {
			result[part.type] = part.value;
			return result;
		}, {});
	const localDate = new Date(
		Date.UTC(
			Number(parts.year),
			Number(parts.month) - 1,
			Number(parts.day) + (Number(parts.hour) * 60 + Number(parts.minute) >= 1290 ? 1 : 0)
		)
	);
	return localDate.toISOString().slice(0, 10);
}

function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dailyPapersDateFromPaper(paper: Record<string, unknown>): string | undefined {
	return stringValue(paper.submittedOnDailyAt)?.slice(0, 10);
}

function dailyPapersUri(date: string): string {
	return `hf://papers/daily/${date.replaceAll('-', '/')}`;
}

function paperWebUrl(paperId: string): string {
	return `https://huggingface.co/papers/${paperId}`;
}

function arxivUrl(paperId: string): string {
	return `https://arxiv.org/abs/${paperId}`;
}

function paperWebMetadata(
	paperId: string,
	paper: PaperData
): Pick<HfFsStatResult, 'published_at' | 'daily_papers_date' | 'daily_papers_uri' | 'url' | 'arxiv_url'> {
	const dailyPapersDate = dailyPapersDateFromPaper(paper);
	return {
		published_at: stringValue(paper.publishedAt),
		daily_papers_date: dailyPapersDate,
		daily_papers_uri: dailyPapersDate ? dailyPapersUri(dailyPapersDate) : undefined,
		url: paperWebUrl(paperId),
		arxiv_url: arxivUrl(paperId),
	};
}

function validatePaperParams(params: HfFsParams): void {
	if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 10_000)) {
		throw new Error('EINVAL: limit must be an integer between 1 and 10000');
	}
}

function entryFilter(params: HfFsParams): (entry: HfFsEntry) => boolean {
	return (entry) => params.entry_type === undefined || entry.type === params.entry_type;
}

function matchesFind(entry: HfFsEntry, params: HfFsParams, relative: string): boolean {
	if (!entryFilter(params)(entry)) {
		return false;
	}
	if (params.name && !picomatch(params.name, { dot: true })(entry.name ?? basename(entry.path))) {
		return false;
	}
	return !params.path || picomatch(params.path, { dot: true })(relative);
}

function statToEntry(stat: HfFsStatResult): HfFsEntry {
	return compactEntry({
		type: stat.type === 'file' ? 'file' : 'dir',
		path: stat.path,
		uri: stat.uri,
		size: stat.size,
		content_type: stat.content_type,
	});
}

function isDescendant(path: string, base: string): boolean {
	return !base || path.startsWith(`${base}/`);
}

function relativePath(base: string, path: string): string {
	return base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

function basename(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

function compactEntry(entry: HfFsEntry): HfFsEntry {
	return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as HfFsEntry;
}

function hasNextLink(link: string | null): boolean {
	return link?.split(',').some((part) => /rel\s*=\s*"?next"?/i.test(part)) ?? false;
}

function caseInsensitiveCompare(left: string, right: string): number {
	return left.localeCompare(right, undefined, { sensitivity: 'base' }) || left.localeCompare(right);
}

function recordArray(value: unknown, key: string): LinkedRepoData[] {
	if (!isRecord(value) || !Array.isArray(value[key])) {
		return [];
	}
	return value[key].filter(isRecord);
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const strings = value.filter((item): item is string => typeof item === 'string');
	return strings.length ? strings : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === 'boolean' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

async function assertOk(response: Response, label: string): Promise<void> {
	if (response.ok) {
		return;
	}
	if (response.status === 401 || response.status === 403) {
		throw new Error('EACCES: permission denied');
	}
	if (response.status === 404) {
		throw new Error('ENOENT: no such file or directory');
	}
	throw new Error(`Hub ${label} failed with status ${response.status.toString()}: ${await response.text()}`);
}
