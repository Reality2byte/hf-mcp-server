import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { z } from 'zod';
import { performance } from 'node:perf_hooks';
import { whoAmI, type WhoAmI } from '@huggingface/hub';
import {
	SpaceSearchTool,
	formatSearchResults,
	SEMANTIC_SEARCH_TOOL_CONFIG,
	type SearchParams,
	MODEL_SEARCH_TOOL_CONFIG,
	type ModelSearchParams,
	RepoSearchTool,
	REPO_SEARCH_TOOL_CONFIG,
	type RepoSearchParams,
	CreateRepoTool,
	formatCreateRepoResult,
	type CreateRepoParams,
	ModelDetailTool,
	MODEL_DETAIL_TOOL_CONFIG,
	MODEL_DETAIL_PROMPT_CONFIG,
	type ModelDetailParams,
	PaperSearchTool,
	PAPER_SEARCH_TOOL_CONFIG,
	DATASET_SEARCH_TOOL_CONFIG,
	type DatasetSearchParams,
	DatasetDetailTool,
	DATASET_DETAIL_TOOL_CONFIG,
	DATASET_DETAIL_PROMPT_CONFIG,
	type DatasetDetailParams,
	HUB_REPO_DETAILS_TOOL_CONFIG,
	HubInspectTool,
	type HubInspectParams,
	HF_FILES_FLAG,
	HF_FS_TOOL_CONFIG,
	HF_FS_TOOL_ID,
	HfFsTool,
	formatHfFsMarkdown,
	type HfFsRequest,
	HfFsWriteTool,
	formatHfFsWriteMarkdown,
	type HfFsWriteParams,
	DuplicateSpaceTool,
	formatDuplicateResult,
	type DuplicateSpaceParams,
	SpaceInfoTool,
	formatSpaceInfoResult,
	SpaceFilesTool,
	type SpaceFilesParams,
	type SpaceInfoParams,
	UseSpaceTool,
	USE_SPACE_TOOL_CONFIG,
	formatUseSpaceResult,
	type UseSpaceParams,
	UserSummaryPrompt,
	USER_SUMMARY_PROMPT_CONFIG,
	type UserSummaryParams,
	PaperSummaryPrompt,
	PAPER_SUMMARY_PROMPT_CONFIG,
	type PaperSummaryParams,
	CONFIG_GUIDANCE,
	TOOL_ID_GROUPS,
	DOCS_SEMANTIC_SEARCH_CONFIG,
	DocSearchTool,
	type DocSearchParams,
	DOC_FETCH_CONFIG,
	DocFetchTool,
	type DocFetchParams,
	HF_JOBS_TOOL_CONFIG,
	HfJobsTool,
	HfSandboxExecTool,
	HfSandboxTool,
	HfSandboxFsTool,
	formatSandboxMarkdown,
	formatSandboxExecMarkdown,
	formatSandboxFsMarkdown,
	type HfSandboxParams,
	type HfSandboxExecParams,
	type HfSandboxFsParams,
	type SandboxProgress,
	getDynamicSpaceToolConfig,
	SpaceTool,
	type SpaceArgs,
	type InvokeResult,
	type ToolResult,
	VIEW_PARAMETERS,
} from '@llmindset/hf-mcp';

import type { ServerFactory, ServerFactoryResult } from './transport/base-transport.js';
import type { McpApiClient } from './utils/mcp-api-client.js';
import type { WebServer } from './web-server.js';
import { logger } from './utils/logger.js';
import { logSearchQuery, logPromptQuery, logGradioEvent, type QueryLoggerOptions } from './utils/query-logger.js';
import type { AppSettings } from '../shared/settings.js';
import { extractAuthBouquetAndMix } from './utils/auth-utils.js';
import {
	AUTHENTICATED_BUILTIN_TOOL_IDS,
	ToolSelectionStrategy,
	type ToolSelectionContext,
} from './utils/tool-selection-strategy.js';
import { hasReadmeFlag } from '../shared/behavior-flags.js';
import { registerCapabilities } from './utils/capability-utils.js';
import { createGradioWidgetResourceConfig } from './resources/gradio-widget-resource.js';
import { applyResultPostProcessing, type GradioToolCallOptions } from './utils/gradio-tool-caller.js';
import { registerSkillResources } from './skills/skill-resources.js';
import { isClientDenied } from '../shared/client-denylist.js';
import { getSkillCatalog } from './skills/skill-catalog-cache.js';
import { SERVER_VERSION } from './server-build-info.js';
import { disableConfiguredTool, parseDisabledTools } from './utils/disabled-tools.js';

// Fallback settings when API/user settings are unavailable.
export const BOUQUET_FALLBACK: AppSettings = {
	builtInTools: [...TOOL_ID_GROUPS.hf_api, HF_FS_TOOL_ID],
	spaceTools: [],
};

// Bouquet configurations moved to tool-selection-strategy.ts

/**
 * Creates a ServerFactory function that produces McpServer instances with all tools registered
 * The shared ApiClient provides global tool state management across all server instances
 */
export const createServerFactory = (_webServerInstance: WebServer, sharedApiClient: McpApiClient): ServerFactory => {
	return async (
		headers: Record<string, string> | null,
		userSettings?: AppSettings,
		skipGradio?: boolean,
		sessionInfo?: {
			clientSessionId?: string;
			isAuthenticated?: boolean;
			clientInfo?: { name: string; version: string };
		}
	): Promise<ServerFactoryResult> => {
		logger.debug({ skipGradio, sessionInfo }, '=== CREATING NEW MCP SERVER INSTANCE ===');
		// Extract auth using shared utility
		const { hfToken } = extractAuthBouquetAndMix(headers, { allowDefaultHfToken: headers === null });

		// Create tool selection strategy
		const toolSelectionStrategy = new ToolSelectionStrategy(sharedApiClient);

		let userInfo: string =
			'The Hugging Face tools are being used anonymously and rate limits apply. ' +
			'Direct the User to set their HF_TOKEN (instructions at https://hf.co/settings/mcp/), or ' +
			'create an account at https://hf.co/join for higher limits.';
		let username: string | undefined;
		let userDetails: WhoAmI | undefined;

		if (hfToken) {
			try {
				userDetails = await whoAmI({ credentials: { accessToken: hfToken } });
				username = userDetails.name;
				userInfo = `Hugging Face tools are being used by authenticated user '${userDetails.name}'`;
			} catch (error) {
				// unexpected - this should have been caught upstream so severity is warn
				logger.warn({ error: (error as Error).message }, `Failed to authenticate with Hugging Face API`);
			}
		}

		// Helper function to build logging options
		const getLoggingOptions = () => {
			const options = {
				clientSessionId: sessionInfo?.clientSessionId,
				isAuthenticated: sessionInfo?.isAuthenticated ?? !!hfToken,
				clientName: sessionInfo?.clientInfo?.name,
				clientVersion: sessionInfo?.clientInfo?.version,
			};
			logger.debug({ sessionInfo, options }, 'Query logging options:');
			return options;
		};

		type QueryLoggerFn = (
			methodName: string,
			query: string,
			parameters: Record<string, unknown>,
			options?: QueryLoggerOptions
		) => void;

		type BaseQueryLoggerOptions = Omit<QueryLoggerOptions, 'durationMs' | 'error'>;

		interface QueryLoggingConfig<T> {
			methodName: string;
			query: string;
			parameters: Record<string, unknown>;
			baseOptions?: BaseQueryLoggerOptions;
			successOptions?: (result: T) => BaseQueryLoggerOptions | void;
		}

		const runWithQueryLogging = async <T>(
			logFn: QueryLoggerFn,
			config: QueryLoggingConfig<T>,
			work: () => Promise<T>
		): Promise<T> => {
			const getToolResultErrorMessage = (result: T): string | undefined => {
				if (typeof result !== 'object' || result === null || !('isError' in result)) {
					return undefined;
				}
				if (!(result as { isError?: boolean }).isError) {
					return undefined;
				}
				if ('formatted' in result && typeof (result as { formatted?: unknown }).formatted === 'string') {
					return (result as { formatted: string }).formatted;
				}
				return 'Tool returned an error result';
			};

			const start = performance.now();
			try {
				const result = await work();
				const durationMs = Math.round(performance.now() - start);
				const successOptions = config.successOptions?.(result) ?? {};
				const { success: successOverride, ...restSuccessOptions } = successOptions;
				const resultErrorMessage = getToolResultErrorMessage(result);
				const resultHasError = resultErrorMessage !== undefined;
				const successFlag = successOverride ?? !resultHasError;
				logFn(config.methodName, config.query, config.parameters, {
					...config.baseOptions,
					...restSuccessOptions,
					durationMs,
					success: successFlag,
					...(resultErrorMessage ? { error: resultErrorMessage } : {}),
				});
				return result;
			} catch (error) {
				const durationMs = Math.round(performance.now() - start);
				logFn(config.methodName, config.query, config.parameters, {
					...config.baseOptions,
					durationMs,
					success: false,
					error,
				});
				throw error;
			}
		};

		// Load the experimental skills catalog (cached across sessions). Failure leaves it null and disables skills.
		const skillCatalog = await getSkillCatalog();
		// Some clients (e.g. cursor-vscode) flood the resource surface; deny them the
		// Skills resources entirely — not registered and not advertised.
		const clientDenied = isClientDenied(sessionInfo?.clientInfo?.name, headers?.['user-agent']);
		const hasSkills = !!skillCatalog?.entries.length && !clientDenied;

		// Get tool selection before creating the server so instructions can match advertised tools.
		const toolSelectionContext: ToolSelectionContext = {
			headers,
			userSettings,
			hfToken,
		};
		const toolSelection = await toolSelectionStrategy.selectTools(toolSelectionContext);
		const hfFsInstruction = toolSelection.enabledToolIds.includes(HF_FS_TOOL_ID)
			? '\nhf:// URIs can be converted to browser URLs by replacing hf://buckets/OWNER/NAME/PATH with https://huggingface.co/buckets/OWNER/NAME/resolve/PATH; for models, datasets, and spaces, use https://huggingface.co[/datasets|/spaces]/OWNER/NAME/resolve/main/PATH. URL-encode each path segment.'
			: '';

		/**
		 *  we will set capabilities below. tool registrations automatically set tools: {listChanged: true}.
		 */
		const server = new McpServer(
			{
				name: '@huggingface/mcp-services',
				version: SERVER_VERSION,
				title: 'Hugging Face',
				websiteUrl: 'https://huggingface.co/mcp',
				icons: [
					{
						src: 'https://huggingface.co/favicon.ico',
					},
				],
			},
			{
				instructions:
					'You have tools for using the Hugging Face Hub. ' +
					userInfo +
					hfFsInstruction +
					" arXiv paper id's are often " +
					'used as references between datasets, models and papers. There are over 100 tags in use, ' +
					"common tags include 'Text Generation', 'Transformers', 'Image Classification' and so on.\n",
			}
		);

		interface Tool {
			enable(): void;
			disable(): void;
		}

		const disabledTools = parseDisabledTools();

		const rawNoImageHeader = headers?.['x-mcp-no-image-content'];
		const noImageContentHeaderEnabled =
			typeof rawNoImageHeader === 'string' && rawNoImageHeader.trim().toLowerCase() === 'true';

		// Always register all tools and store instances for dynamic control
		const toolInstances: { [name: string]: Tool } = {};
		const fixedToolInstances: { [name: string]: Tool } = {};

		const whoDescription = userDetails
			? `Hugging Face tools are being used by authenticated user '${username}'`
			: 'Hugging Face tools are being used anonymously and may be rate limited. Call this tool for instructions on joining and authenticating.';

		const response = userDetails ? `You are authenticated as ${username ?? 'unknown'}.` : CONFIG_GUIDANCE;
		fixedToolInstances.hf_whoami = server.registerTool(
			'hf_whoami',
			{
				title: 'Hugging Face User Info',
				description: whoDescription,
				inputSchema: {},
				annotations: { readOnlyHint: true, openWorldHint: false, title: 'Hugging Face User Info' },
			},
			() => {
				return { content: [{ type: 'text', text: response }] };
			}
		);

		/** always leave tool active so flow can complete / allow uid change */
		if (process.env.AUTHENTICATE_TOOL === 'true') {
			fixedToolInstances.Authenticate = server.registerTool(
				'Authenticate',
				{
					title: 'Hugging Face Authentication',
					description: 'Authenticate with Hugging Face',
					inputSchema: {},
					annotations: { title: 'Hugging Face Authentication' },
				},
				() => {
					return { content: [{ type: 'text', text: 'You have successfully authenticated' }] };
				}
			);
		}

		server.registerPrompt(
			USER_SUMMARY_PROMPT_CONFIG.name,
			{
				description: USER_SUMMARY_PROMPT_CONFIG.description,
				argsSchema: USER_SUMMARY_PROMPT_CONFIG.schema.shape,
			},
			async (params: UserSummaryParams) => {
				const summaryText = await runWithQueryLogging(
					logPromptQuery,
					{
						methodName: USER_SUMMARY_PROMPT_CONFIG.name,
						query: params.user_id,
						parameters: { user_id: params.user_id },
						baseOptions: getLoggingOptions(),
						successOptions: (text) => ({
							totalResults: 1,
							resultsShared: 1,
							responseCharCount: text.length,
						}),
					},
					async () => {
						const userSummary = new UserSummaryPrompt(hfToken);
						return userSummary.generateSummary(params);
					}
				);

				return {
					description: `User summary for ${params.user_id}`,
					messages: [
						{
							role: 'user' as const,
							content: {
								type: 'text' as const,
								text: summaryText,
							},
						},
					],
				};
			}
		);

		server.registerPrompt(
			PAPER_SUMMARY_PROMPT_CONFIG.name,
			{
				description: PAPER_SUMMARY_PROMPT_CONFIG.description,
				argsSchema: PAPER_SUMMARY_PROMPT_CONFIG.schema.shape,
			},
			async (params: PaperSummaryParams) => {
				const summaryText = await runWithQueryLogging(
					logPromptQuery,
					{
						methodName: PAPER_SUMMARY_PROMPT_CONFIG.name,
						query: params.paper_id,
						parameters: { paper_id: params.paper_id },
						baseOptions: getLoggingOptions(),
						successOptions: (text) => ({
							totalResults: 1,
							resultsShared: 1,
							responseCharCount: text.length,
						}),
					},
					async () => {
						const paperSummary = new PaperSummaryPrompt(hfToken);
						return paperSummary.generateSummary(params);
					}
				);

				return {
					description: `Paper summary for ${params.paper_id}`,
					messages: [
						{
							role: 'user' as const,
							content: {
								type: 'text' as const,
								text: summaryText,
							},
						},
					],
				};
			}
		);

		server.registerPrompt(
			MODEL_DETAIL_PROMPT_CONFIG.name,
			{
				description: MODEL_DETAIL_PROMPT_CONFIG.description,
				argsSchema: MODEL_DETAIL_PROMPT_CONFIG.schema.shape,
			},
			async (params: ModelDetailParams) => {
				const result = await runWithQueryLogging(
					logPromptQuery,
					{
						methodName: MODEL_DETAIL_PROMPT_CONFIG.name,
						query: params.model_id,
						parameters: { model_id: params.model_id },
						baseOptions: getLoggingOptions(),
						successOptions: (details) => ({
							totalResults: details.totalResults,
							resultsShared: details.resultsShared,
							responseCharCount: details.formatted.length,
						}),
					},
					async () => {
						const modelDetail = new ModelDetailTool(hfToken, undefined);
						return modelDetail.getDetails(params.model_id, true);
					}
				);

				return {
					description: `Model details for ${params.model_id}`,
					messages: [
						{
							role: 'user' as const,
							content: {
								type: 'text' as const,
								text: result.formatted,
							},
						},
					],
				};
			}
		);

		server.registerPrompt(
			DATASET_DETAIL_PROMPT_CONFIG.name,
			{
				description: DATASET_DETAIL_PROMPT_CONFIG.description,
				argsSchema: DATASET_DETAIL_PROMPT_CONFIG.schema.shape,
			},
			async (params: DatasetDetailParams) => {
				const result = await runWithQueryLogging(
					logPromptQuery,
					{
						methodName: DATASET_DETAIL_PROMPT_CONFIG.name,
						query: params.dataset_id,
						parameters: { dataset_id: params.dataset_id },
						baseOptions: getLoggingOptions(),
						successOptions: (details) => ({
							totalResults: details.totalResults,
							resultsShared: details.resultsShared,
							responseCharCount: details.formatted.length,
						}),
					},
					async () => {
						const datasetDetail = new DatasetDetailTool(hfToken, undefined);
						return datasetDetail.getDetails(params.dataset_id, true);
					}
				);

				return {
					description: `Dataset details for ${params.dataset_id}`,
					messages: [
						{
							role: 'user' as const,
							content: {
								type: 'text' as const,
								text: result.formatted,
							},
						},
					],
				};
			}
		);

		toolInstances[SEMANTIC_SEARCH_TOOL_CONFIG.name] = server.registerTool(
			SEMANTIC_SEARCH_TOOL_CONFIG.name,
			{
				title: SEMANTIC_SEARCH_TOOL_CONFIG.annotations.title,
				description: SEMANTIC_SEARCH_TOOL_CONFIG.description,
				inputSchema: SEMANTIC_SEARCH_TOOL_CONFIG.schema.shape,
				annotations: SEMANTIC_SEARCH_TOOL_CONFIG.annotations,
			},
			async (params: SearchParams) => {
				const result = await runWithQueryLogging(
					logSearchQuery,
					{
						methodName: SEMANTIC_SEARCH_TOOL_CONFIG.name,
						query: params.query,
						parameters: { limit: params.limit, mcp: params.mcp },
						baseOptions: getLoggingOptions(),
						successOptions: (formatted) => ({
							totalResults: formatted.totalResults,
							resultsShared: formatted.resultsShared,
							responseCharCount: formatted.formatted.length,
						}),
					},
					async () => {
						const semanticSearch = new SpaceSearchTool(hfToken);
						const searchResult = await semanticSearch.search(params.query, params.limit, params.mcp);
						return formatSearchResults(params.query, searchResult.results, searchResult.totalCount);
					}
				);
				return {
					content: [{ type: 'text', text: result.formatted }],
				};
			}
		);

		toolInstances[MODEL_SEARCH_TOOL_CONFIG.name] = server.registerTool(
			MODEL_SEARCH_TOOL_CONFIG.name,
			{
				title: MODEL_SEARCH_TOOL_CONFIG.annotations.title,
				description: MODEL_SEARCH_TOOL_CONFIG.description,
				inputSchema: MODEL_SEARCH_TOOL_CONFIG.schema.shape,
				annotations: MODEL_SEARCH_TOOL_CONFIG.annotations,
			},
			async (params: ModelSearchParams) => {
				const filters: string[] = [];
				if (params.task) filters.push(params.task);
				if (params.library) filters.push(params.library);

				const repoParams: Partial<RepoSearchParams> = {
					query: params.query,
					repo_types: ['model'],
					author: params.author,
					sort: params.sort,
					limit: params.limit,
					...(filters.length > 0 ? { filters } : {}),
				};

				const result = await runWithQueryLogging(
					logSearchQuery,
					{
						methodName: MODEL_SEARCH_TOOL_CONFIG.name,
						query: params.query || `sort:${params.sort || 'trendingScore'}`,
						parameters: params,
						baseOptions: getLoggingOptions(),
						successOptions: (formatted) => ({
							totalResults: formatted.totalResults,
							resultsShared: formatted.resultsShared,
							responseCharCount: formatted.formatted.length,
						}),
					},
					async () => {
						const repoSearch = new RepoSearchTool(hfToken);
						return repoSearch.searchWithParams(repoParams);
					}
				);
				return {
					content: [{ type: 'text', text: result.formatted }],
				};
			}
		);

		toolInstances[REPO_SEARCH_TOOL_CONFIG.name] = server.registerTool(
			REPO_SEARCH_TOOL_CONFIG.name,
			{
				title: REPO_SEARCH_TOOL_CONFIG.annotations.title,
				description: REPO_SEARCH_TOOL_CONFIG.description,
				inputSchema: REPO_SEARCH_TOOL_CONFIG.schema.shape,
				annotations: REPO_SEARCH_TOOL_CONFIG.annotations,
			},
			async (params: RepoSearchParams) => {
				const result = await runWithQueryLogging(
					logSearchQuery,
					{
						methodName: REPO_SEARCH_TOOL_CONFIG.name,
						query: params.query || `sort:${params.sort || 'trendingScore'}`,
						parameters: params,
						baseOptions: getLoggingOptions(),
						successOptions: (formatted) => ({
							totalResults: formatted.totalResults,
							resultsShared: formatted.resultsShared,
							responseCharCount: formatted.formatted.length,
						}),
					},
					async () => {
						const repoSearch = new RepoSearchTool(hfToken);
						return repoSearch.searchWithParams(params);
					}
				);
				return {
					content: [{ type: 'text', text: result.formatted }],
				};
			}
		);

		const createRepoToolConfig = CreateRepoTool.createToolConfig();
		toolInstances[createRepoToolConfig.name] = server.registerTool(
			createRepoToolConfig.name,
			{
				title: createRepoToolConfig.annotations.title,
				description: createRepoToolConfig.description,
				inputSchema: createRepoToolConfig.schema.shape,
				outputSchema: createRepoToolConfig.outputSchema.shape,
				annotations: createRepoToolConfig.annotations,
			},
			async (params: CreateRepoParams) => {
				const result = await runWithQueryLogging(
					logPromptQuery,
					{
						methodName: createRepoToolConfig.name,
						query: params.source_uri ? `duplicate:${params.source_uri}->${params.uri}` : `create:${params.uri}`,
						parameters: params,
						baseOptions: getLoggingOptions(),
						successOptions: (created) => ({
							resultsShared: 1,
							responseCharCount: formatCreateRepoResult(created).length,
						}),
					},
					async () => {
						const createRepoTool = new CreateRepoTool(hfToken);
						return createRepoTool.create(params);
					}
				);
				return {
					structuredContent: { ...result },
					content: [{ type: 'text', text: formatCreateRepoResult(result) }],
				};
			}
		);

		toolInstances[MODEL_DETAIL_TOOL_CONFIG.name] = server.registerTool(
			MODEL_DETAIL_TOOL_CONFIG.name,
			{
				title: MODEL_DETAIL_TOOL_CONFIG.annotations.title,
				description: MODEL_DETAIL_TOOL_CONFIG.description,
				inputSchema: MODEL_DETAIL_TOOL_CONFIG.schema.shape,
				annotations: MODEL_DETAIL_TOOL_CONFIG.annotations,
			},
			async (params: ModelDetailParams) => {
				const result = await runWithQueryLogging(
					logPromptQuery,
					{
						methodName: MODEL_DETAIL_TOOL_CONFIG.name,
						query: params.model_id,
						parameters: { model_id: params.model_id },
						baseOptions: getLoggingOptions(),
						successOptions: (details) => ({
							totalResults: details.totalResults,
							resultsShared: details.resultsShared,
							responseCharCount: details.formatted.length,
						}),
					},
					async () => {
						const modelDetail = new ModelDetailTool(hfToken, undefined);
						return modelDetail.getDetails(params.model_id, false);
					}
				);
				return {
					content: [{ type: 'text', text: result.formatted }],
				};
			}
		);

		toolInstances[PAPER_SEARCH_TOOL_CONFIG.name] = server.registerTool(
			PAPER_SEARCH_TOOL_CONFIG.name,
			{
				title: PAPER_SEARCH_TOOL_CONFIG.annotations.title,
				description: PAPER_SEARCH_TOOL_CONFIG.description,
				inputSchema: PAPER_SEARCH_TOOL_CONFIG.schema.shape,
				annotations: PAPER_SEARCH_TOOL_CONFIG.annotations,
			},
			async (params: z.infer<typeof PAPER_SEARCH_TOOL_CONFIG.schema>) => {
				const result = await runWithQueryLogging(
					logSearchQuery,
					{
						methodName: PAPER_SEARCH_TOOL_CONFIG.name,
						query: params.query,
						parameters: { results_limit: params.results_limit, concise_only: params.concise_only },
						baseOptions: getLoggingOptions(),
						successOptions: (formatted) => ({
							totalResults: formatted.totalResults,
							resultsShared: formatted.resultsShared,
							responseCharCount: formatted.formatted.length,
						}),
					},
					async () => {
						const paperSearchTool = new PaperSearchTool(hfToken);
						return paperSearchTool.search(params.query, params.results_limit, params.concise_only);
					}
				);
				return {
					content: [{ type: 'text', text: result.formatted }],
				};
			}
		);

		toolInstances[DATASET_SEARCH_TOOL_CONFIG.name] = server.registerTool(
			DATASET_SEARCH_TOOL_CONFIG.name,
			{
				title: DATASET_SEARCH_TOOL_CONFIG.annotations.title,
				description: DATASET_SEARCH_TOOL_CONFIG.description,
				inputSchema: DATASET_SEARCH_TOOL_CONFIG.schema.shape,
				annotations: DATASET_SEARCH_TOOL_CONFIG.annotations,
			},
			async (params: DatasetSearchParams) => {
				const repoParams: Partial<RepoSearchParams> = {
					query: params.query,
					repo_types: ['dataset'],
					author: params.author,
					sort: params.sort,
					limit: params.limit,
					...(params.tags && params.tags.length > 0 ? { filters: params.tags } : {}),
				};

				const result = await runWithQueryLogging(
					logSearchQuery,
					{
						methodName: DATASET_SEARCH_TOOL_CONFIG.name,
						query: params.query || `sort:${params.sort || 'trendingScore'}`,
						parameters: params,
						baseOptions: getLoggingOptions(),
						successOptions: (formatted) => ({
							totalResults: formatted.totalResults,
							resultsShared: formatted.resultsShared,
							responseCharCount: formatted.formatted.length,
						}),
					},
					async () => {
						const repoSearch = new RepoSearchTool(hfToken);
						return repoSearch.searchWithParams(repoParams);
					}
				);
				return {
					content: [{ type: 'text', text: result.formatted }],
				};
			}
		);

		toolInstances[DATASET_DETAIL_TOOL_CONFIG.name] = server.registerTool(
			DATASET_DETAIL_TOOL_CONFIG.name,
			{
				title: DATASET_DETAIL_TOOL_CONFIG.annotations.title,
				description: DATASET_DETAIL_TOOL_CONFIG.description,
				inputSchema: DATASET_DETAIL_TOOL_CONFIG.schema.shape,
				annotations: DATASET_DETAIL_TOOL_CONFIG.annotations,
			},
			async (params: DatasetDetailParams) => {
				const result = await runWithQueryLogging(
					logPromptQuery,
					{
						methodName: DATASET_DETAIL_TOOL_CONFIG.name,
						query: params.dataset_id,
						parameters: { dataset_id: params.dataset_id },
						baseOptions: getLoggingOptions(),
						successOptions: (details) => ({
							totalResults: details.totalResults,
							resultsShared: details.resultsShared,
							responseCharCount: details.formatted.length,
						}),
					},
					async () => {
						const datasetDetail = new DatasetDetailTool(hfToken, undefined);
						return datasetDetail.getDetails(params.dataset_id, false);
					}
				);
				return {
					content: [{ type: 'text', text: result.formatted }],
				};
			}
		);

		// Compute README availability; adjust description and schema accordingly
		const hubInspectReadmeAllowed = hasReadmeFlag(toolSelection.enabledToolIds);
		const hubInspectDescription = hubInspectReadmeAllowed
			? `${HUB_REPO_DETAILS_TOOL_CONFIG.description} README file may be requested from the external repository.`
			: HUB_REPO_DETAILS_TOOL_CONFIG.description;
		const hubInspectBaseShape = HUB_REPO_DETAILS_TOOL_CONFIG.schema.shape as z.ZodRawShape;
		const hubInspectSchemaShape: z.ZodRawShape = hubInspectReadmeAllowed
			? hubInspectBaseShape
			: (() => {
					const { include_readme: _omit, ...rest } = hubInspectBaseShape as unknown as Record<string, unknown>;
					return rest as unknown as z.ZodRawShape;
				})();

		toolInstances[HUB_REPO_DETAILS_TOOL_CONFIG.name] = server.registerTool(
			HUB_REPO_DETAILS_TOOL_CONFIG.name,
			{
				description: hubInspectDescription,
				inputSchema: hubInspectSchemaShape,
				annotations: HUB_REPO_DETAILS_TOOL_CONFIG.annotations,
			},
			async (params: Record<string, unknown>) => {
				// Re-evaluate flag dynamically to reflect UI changes without restarting server
				const currentSelection = await toolSelectionStrategy.selectTools(toolSelectionContext);
				const allowReadme = hasReadmeFlag(currentSelection.enabledToolIds);
				const wantReadme = (params as { include_readme?: boolean }).include_readme === true; // explicit opt-in required
				const includeReadme = allowReadme && wantReadme;

				// Prepare safe logging parameters without relying on strong typing
				const repoIdsParam = (params as { repo_ids?: unknown }).repo_ids;
				const repoIds = Array.isArray(repoIdsParam)
					? repoIdsParam.filter((repoId): repoId is string => typeof repoId === 'string')
					: [];
				const joinedRepoIds = repoIds.join(', ');
				const loggedRepoIds = joinedRepoIds.length > 500 ? `${joinedRepoIds.slice(0, 497)}...` : joinedRepoIds;
				const repoType = (params as { repo_type?: unknown }).repo_type as unknown;
				const repoTypeSafe =
					repoType === 'model' || repoType === 'dataset' || repoType === 'space' ? repoType : undefined;
				const operationsParam = (params as { operations?: unknown }).operations;
				const operations = Array.isArray(operationsParam)
					? operationsParam.filter((operation): operation is string => typeof operation === 'string')
					: undefined;
				const config = (params as { config?: unknown }).config;
				const split = (params as { split?: unknown }).split;
				const offset = (params as { offset?: unknown }).offset;
				const limit = (params as { limit?: unknown }).limit;

				const result = await runWithQueryLogging(
					logPromptQuery,
					{
						methodName: HUB_REPO_DETAILS_TOOL_CONFIG.name,
						query: loggedRepoIds,
						parameters: {
							repo_ids: repoIds,
							count: repoIds.length,
							repo_type: repoTypeSafe,
							include_readme: includeReadme,
							operations,
							config: typeof config === 'string' ? config : undefined,
							split: typeof split === 'string' ? split : undefined,
							offset: typeof offset === 'number' ? offset : undefined,
							limit: typeof limit === 'number' ? limit : undefined,
						},
						baseOptions: getLoggingOptions(),
						successOptions: (details) => ({
							totalResults: details.totalResults,
							resultsShared: details.resultsShared,
							responseCharCount: details.formatted.length,
						}),
					},
					async () => {
						const tool = new HubInspectTool(hfToken, undefined);
						return tool.inspect(params as unknown as HubInspectParams, includeReadme);
					}
				);
				return {
					content: [{ type: 'text', text: result.formatted }],
				};
			}
		);

		const hfFsToolConfig = HF_FS_TOOL_CONFIG;
		toolInstances[hfFsToolConfig.name] = server.registerTool(
			hfFsToolConfig.name,
			{
				title: hfFsToolConfig.title,
				description: hfFsToolConfig.description,
				inputSchema: hfFsToolConfig.schema.shape,
				outputSchema: hfFsToolConfig.outputSchema.shape,
				annotations: hfFsToolConfig.annotations,
			},
			async (request: HfFsRequest) => {
				const result = await runWithQueryLogging(
					logPromptQuery,
					{
						methodName: hfFsToolConfig.name,
						query: [request.cmd, ...request.args].join(' '),
						parameters: {
							cmd: request.cmd,
							args: request.args,
						},
						baseOptions: getLoggingOptions(),
						successOptions: (fsResult) => {
							const shared =
								'entries' in fsResult ? fsResult.entries.length : fsResult.op === 'stat' && !fsResult.exists ? 0 : 1;
							return {
								totalResults: 'entries' in fsResult ? fsResult.entries.length : shared,
								resultsShared: shared,
								responseCharCount: formatHfFsMarkdown(fsResult).length,
							};
						},
					},
					async () => {
						const tool = new HfFsTool(hfToken, undefined);
						return await tool.run(request);
					}
				);
				return {
					structuredContent: { ...result },
					content: [{ type: 'text', text: formatHfFsMarkdown(result) }],
				};
			}
		);

		if (hfToken && toolSelection.enabledToolIds.includes(HF_FILES_FLAG)) {
			const hfFsWriteToolConfig = HfFsWriteTool.createToolConfig();
			fixedToolInstances[hfFsWriteToolConfig.name] = server.registerTool(
				hfFsWriteToolConfig.name,
				{
					title: hfFsWriteToolConfig.title,
					description: hfFsWriteToolConfig.description,
					inputSchema: hfFsWriteToolConfig.schema.shape,
					outputSchema: hfFsWriteToolConfig.outputSchema.shape,
					annotations: hfFsWriteToolConfig.annotations,
				},
				async (params: HfFsWriteParams) => {
					const result = await runWithQueryLogging(
						logPromptQuery,
						{
							methodName: hfFsWriteToolConfig.name,
							query: params.uri,
							parameters: {
								op: params.op,
								uri: params.uri,
								branch: params.branch,
								message: params.message,
								content_type:
									params.op === 'put'
										? params.text !== undefined
											? 'text'
											: params.base64 !== undefined
												? 'base64'
												: undefined
										: undefined,
							},
							baseOptions: getLoggingOptions(),
							successOptions: (writeResult) => ({
								totalResults: 1,
								resultsShared: 1,
								responseCharCount: formatHfFsWriteMarkdown(writeResult).length,
							}),
						},
						async () => {
							const tool = new HfFsWriteTool(hfToken, undefined);
							return await tool.run(params);
						}
					);
					return {
						structuredContent: { ...result },
						content: [{ type: 'text', text: formatHfFsWriteMarkdown(result) }],
					};
				}
			);
		}

		toolInstances[DOCS_SEMANTIC_SEARCH_CONFIG.name] = server.registerTool(
			DOCS_SEMANTIC_SEARCH_CONFIG.name,
			{
				title: DOCS_SEMANTIC_SEARCH_CONFIG.annotations.title,
				description: DOCS_SEMANTIC_SEARCH_CONFIG.description,
				inputSchema: DOCS_SEMANTIC_SEARCH_CONFIG.schema.shape,
				annotations: DOCS_SEMANTIC_SEARCH_CONFIG.annotations,
			},
			async (params: DocSearchParams) => {
				const result = await runWithQueryLogging(
					logSearchQuery,
					{
						methodName: DOCS_SEMANTIC_SEARCH_CONFIG.name,
						query: params.query,
						parameters: { product: params.product },
						baseOptions: getLoggingOptions(),
						successOptions: (formatted) => ({
							totalResults: formatted.totalResults,
							resultsShared: formatted.resultsShared,
							responseCharCount: formatted.formatted.length,
						}),
					},
					async () => {
						const docSearch = new DocSearchTool(hfToken);
						return docSearch.search(params);
					}
				);
				return {
					content: [{ type: 'text', text: result.formatted }],
				};
			}
		);

		toolInstances[DOC_FETCH_CONFIG.name] = server.registerTool(
			DOC_FETCH_CONFIG.name,
			{
				title: DOC_FETCH_CONFIG.annotations.title,
				description: DOC_FETCH_CONFIG.description,
				inputSchema: DOC_FETCH_CONFIG.schema.shape,
				annotations: DOC_FETCH_CONFIG.annotations,
			},
			async (params: DocFetchParams) => {
				const results = await runWithQueryLogging(
					logSearchQuery,
					{
						methodName: DOC_FETCH_CONFIG.name,
						query: params.doc_url,
						parameters: { offset: params.offset },
						baseOptions: getLoggingOptions(),
						successOptions: (content) => ({
							totalResults: 1,
							resultsShared: 1,
							responseCharCount: content.length,
						}),
					},
					async () => {
						const docFetch = new DocFetchTool();
						return docFetch.fetch(params);
					}
				);
				return {
					content: [{ type: 'text', text: results }],
				};
			}
		);

		const duplicateToolConfig = DuplicateSpaceTool.createToolConfig(username);
		toolInstances[duplicateToolConfig.name] = server.registerTool(
			duplicateToolConfig.name,
			{
				title: duplicateToolConfig.annotations.title,
				description: duplicateToolConfig.description,
				inputSchema: duplicateToolConfig.schema.shape,
				annotations: duplicateToolConfig.annotations,
			},
			async (params: DuplicateSpaceParams) => {
				const duplicateSpace = new DuplicateSpaceTool(hfToken, username);
				const result = await duplicateSpace.duplicate(params);
				return {
					content: [{ type: 'text', text: formatDuplicateResult(result) }],
				};
			}
		);

		const spaceInfoToolConfig = SpaceInfoTool.createToolConfig(username);
		toolInstances[spaceInfoToolConfig.name] = server.registerTool(
			spaceInfoToolConfig.name,
			{
				title: spaceInfoToolConfig.annotations.title,
				description: spaceInfoToolConfig.description,
				inputSchema: spaceInfoToolConfig.schema.shape,
				annotations: spaceInfoToolConfig.annotations,
			},
			async (params: SpaceInfoParams) => {
				const spaceInfoTool = new SpaceInfoTool(hfToken, username);
				const result = await formatSpaceInfoResult(spaceInfoTool, params);
				return {
					content: [{ type: 'text', text: result }],
				};
			}
		);

		const spaceFilesToolConfig = SpaceFilesTool.createToolConfig(username);
		toolInstances[spaceFilesToolConfig.name] = server.registerTool(
			spaceFilesToolConfig.name,
			{
				title: spaceFilesToolConfig.annotations.title,
				description: spaceFilesToolConfig.description,
				inputSchema: spaceFilesToolConfig.schema.shape,
				annotations: spaceFilesToolConfig.annotations,
			},
			async (params: SpaceFilesParams) => {
				const spaceFilesTool = new SpaceFilesTool(hfToken, username);
				const result = await spaceFilesTool.listFiles(params);
				return {
					content: [{ type: 'text', text: result }],
				};
			}
		);

		toolInstances[USE_SPACE_TOOL_CONFIG.name] = server.registerTool(
			USE_SPACE_TOOL_CONFIG.name,
			{
				title: USE_SPACE_TOOL_CONFIG.annotations.title,
				description: USE_SPACE_TOOL_CONFIG.description,
				inputSchema: USE_SPACE_TOOL_CONFIG.schema.shape,
				annotations: USE_SPACE_TOOL_CONFIG.annotations,
			},
			async (params: UseSpaceParams) => {
				const result = await runWithQueryLogging(
					logPromptQuery,
					{
						methodName: USE_SPACE_TOOL_CONFIG.name,
						query: params.space_id,
						parameters: { space_id: params.space_id },
						baseOptions: getLoggingOptions(),
						successOptions: (useSpaceResult) => ({
							totalResults: useSpaceResult.metadata.totalResults,
							resultsShared: useSpaceResult.metadata.resultsShared,
							responseCharCount: useSpaceResult.metadata.formatted.length,
						}),
					},
					async () => {
						const useSpaceTool = new UseSpaceTool(hfToken, undefined);
						return formatUseSpaceResult(useSpaceTool, params);
					}
				);
				return {
					content: result.content,
				};
			}
		);

		toolInstances[HF_JOBS_TOOL_CONFIG.name] = server.registerTool(
			HF_JOBS_TOOL_CONFIG.name,
			{
				title: HF_JOBS_TOOL_CONFIG.annotations.title,
				description: HF_JOBS_TOOL_CONFIG.description,
				inputSchema: HF_JOBS_TOOL_CONFIG.schema.shape,
				annotations: HF_JOBS_TOOL_CONFIG.annotations,
			},
			async (params: z.infer<typeof HF_JOBS_TOOL_CONFIG.schema>) => {
				// Jobs require authentication - check if user has token
				const isAuthenticated = !!hfToken;
				const loggedOperation = params.operation ?? 'no-operation';
				const result = await runWithQueryLogging(
					logSearchQuery,
					{
						methodName: HF_JOBS_TOOL_CONFIG.name,
						query: loggedOperation,
						parameters: params.args || {},
						baseOptions: getLoggingOptions(),
						successOptions: (jobResult) => ({
							totalResults: jobResult.totalResults,
							resultsShared: jobResult.resultsShared,
							responseCharCount: jobResult.formatted.length,
						}),
					},
					async () => {
						const jobsTool = new HfJobsTool(hfToken, isAuthenticated, username);
						return jobsTool.execute(params);
					}
				);

				return {
					content: [{ type: 'text', text: result.formatted }],
					...(result.isError && { isError: true }),
				};
			}
		);

		const SANDBOX_REDACTED_KEYS = ['handle', 'sandbox_token', 'text', 'base64', 'stdin', 'body', 'env'];
		const redactSandboxParameters = (args: Record<string, unknown> | undefined): Record<string, unknown> => {
			if (!args) {
				return {};
			}

			return Object.fromEntries(
				Object.entries(args).map(([key, value]) => {
					if (SANDBOX_REDACTED_KEYS.includes(key)) {
						return [key, '<redacted>'];
					}
					return [key, value];
				})
			);
		};
		const createSandboxProgressRelay = (
			extra: RequestHandlerExtra<ServerRequest, ServerNotification> | undefined
		): ((progress: SandboxProgress) => Promise<void>) | undefined => {
			const progressToken = extra?._meta?.progressToken;
			logger.trace({ hasExtra: Boolean(extra), progressToken: progressToken ?? null }, 'Sandbox progress setup');
			if (progressToken === undefined || (typeof progressToken !== 'number' && typeof progressToken !== 'string')) {
				logger.trace({ hasExtra: Boolean(extra) }, 'Sandbox progress relay disabled');
				return undefined;
			}

			let progressCount = 0;
			let disabled = false;

			return async (progress: SandboxProgress): Promise<void> => {
				if (disabled || !extra) {
					return;
				}
				if (extra.signal?.aborted) {
					disabled = true;
					return;
				}

				progressCount += 1;
				try {
					logger.trace({ progressToken, progress }, 'Relaying sandbox progress');
					const params: {
						progressToken: number | string;
						progress: number;
						total?: number;
						message?: string;
					} = {
						progressToken,
						progress: progress.progress ?? progressCount,
					};
					if (progress.total !== undefined) {
						params.total = progress.total;
					}
					if (progress.message !== undefined) {
						params.message = `${String(progressCount)}. ${progress.message}`;
					}

					await extra.sendNotification({
						method: 'notifications/progress',
						params,
					});
				} catch (error) {
					disabled = true;
					logger.trace({ error }, 'Sandbox progress relay failed');
				}
			};
		};

		const sandboxToolConfig = HfSandboxTool.createToolConfig(username);
		toolInstances[sandboxToolConfig.name] = server.registerTool(
			sandboxToolConfig.name,
			{
				title: sandboxToolConfig.title,
				description: sandboxToolConfig.description,
				inputSchema: sandboxToolConfig.schema.shape,
				outputSchema: sandboxToolConfig.outputSchema.shape,
				annotations: sandboxToolConfig.annotations,
			},
			async (params: HfSandboxParams, extra) => {
				const isAuthenticated = !!hfToken;
				const onProgress = createSandboxProgressRelay(extra);
				const result = await runWithQueryLogging(
					logSearchQuery,
					{
						methodName: sandboxToolConfig.name,
						query: params.op,
						parameters: redactSandboxParameters(params),
						baseOptions: getLoggingOptions(),
						successOptions: (sandboxResult) => ({
							totalResults: 1,
							resultsShared: 1,
							responseCharCount: formatSandboxMarkdown(sandboxResult).length,
						}),
					},
					async () => {
						const sandboxTool = new HfSandboxTool(hfToken, isAuthenticated, username);
						return sandboxTool.run(params, onProgress ? { onProgress } : undefined);
					}
				);

				return {
					structuredContent: { ...result },
					content: [{ type: 'text', text: formatSandboxMarkdown(result) }],
				};
			}
		);

		const sandboxExecToolConfig = HfSandboxExecTool.createToolConfig(username);
		toolInstances[sandboxExecToolConfig.name] = server.registerTool(
			sandboxExecToolConfig.name,
			{
				title: sandboxExecToolConfig.title,
				description: sandboxExecToolConfig.description,
				inputSchema: sandboxExecToolConfig.schema.shape,
				outputSchema: sandboxExecToolConfig.outputSchema.shape,
				annotations: sandboxExecToolConfig.annotations,
			},
			async (params: HfSandboxExecParams, extra) => {
				const isAuthenticated = !!hfToken;
				const onProgress = createSandboxProgressRelay(extra);
				const result = await runWithQueryLogging(
					logSearchQuery,
					{
						methodName: sandboxExecToolConfig.name,
						query: params.cmd,
						parameters: redactSandboxParameters(params),
						baseOptions: getLoggingOptions(),
						successOptions: (execResult) => ({
							totalResults: 1,
							resultsShared: 1,
							responseCharCount: formatSandboxExecMarkdown(execResult).length,
						}),
					},
					async () => {
						const sandboxExecTool = new HfSandboxExecTool(hfToken, isAuthenticated, username);
						return sandboxExecTool.run(params, onProgress ? { onProgress } : undefined);
					}
				);

				return {
					structuredContent: { ...result },
					content: [{ type: 'text', text: formatSandboxExecMarkdown(result) }],
				};
			}
		);

		const sandboxFsToolConfig = HfSandboxFsTool.createToolConfig(username);
		toolInstances[sandboxFsToolConfig.name] = server.registerTool(
			sandboxFsToolConfig.name,
			{
				title: sandboxFsToolConfig.title,
				description: sandboxFsToolConfig.description,
				inputSchema: sandboxFsToolConfig.schema.shape,
				outputSchema: sandboxFsToolConfig.outputSchema.shape,
				annotations: sandboxFsToolConfig.annotations,
			},
			async (params: HfSandboxFsParams) => {
				const isAuthenticated = !!hfToken;
				const result = await runWithQueryLogging(
					logSearchQuery,
					{
						methodName: sandboxFsToolConfig.name,
						query: params.op,
						parameters: redactSandboxParameters(params),
						baseOptions: getLoggingOptions(),
						successOptions: (fsResult) => ({
							totalResults: 1,
							resultsShared: 1,
							responseCharCount: formatSandboxFsMarkdown(fsResult).length,
						}),
					},
					async () => {
						const sandboxFsTool = new HfSandboxFsTool(hfToken, isAuthenticated, username);
						return sandboxFsTool.run(params);
					}
				);

				return {
					structuredContent: { ...result },
					content: [{ type: 'text', text: formatSandboxFsMarkdown(result) }],
				};
			}
		);

		// Get dynamic config based on environment (uses DYNAMIC_SPACE_DATA env var)
		const dynamicSpaceToolConfig = getDynamicSpaceToolConfig();
		toolInstances[dynamicSpaceToolConfig.name] = server.registerTool(
			dynamicSpaceToolConfig.name,
			{
				title: dynamicSpaceToolConfig.annotations.title,
				description: dynamicSpaceToolConfig.description,
				inputSchema: dynamicSpaceToolConfig.schema.shape,
				annotations: dynamicSpaceToolConfig.annotations,
			},
			async (params: SpaceArgs, extra) => {
				// Check if invoke operation is disabled by gradio=none
				const { gradio } = extractAuthBouquetAndMix(headers);
				if (params.operation === 'invoke' && gradio === 'none') {
					const errorMessage =
						'The invoke operation is disabled because gradio=none is set. ' +
						'To use invoke, remove gradio=none from your headers or set gradio to a space ID. ' +
						`You can still use operation=${VIEW_PARAMETERS} to inspect the tool schema.`;
					return {
						content: [{ type: 'text', text: errorMessage }],
						isError: true,
					};
				}

				const loggedOperation = params.operation ?? 'no-operation';

				if (params.operation === 'invoke') {
					const startTime = Date.now();
					let success = false;

					try {
						const spaceTool = new SpaceTool(hfToken);
						const result = await spaceTool.execute(params, extra);

						if ('result' in result && result.result) {
							const invokeResult = result as InvokeResult;
							success = !invokeResult.isError;

							const stripImageContent =
								noImageContentHeaderEnabled || toolSelection.enabledToolIds.includes('NO_GRADIO_IMAGE_CONTENT');
							const postProcessOptions: GradioToolCallOptions = {
								stripImageContent,
								toolName: dynamicSpaceToolConfig.name,
								outwardFacingName: dynamicSpaceToolConfig.name,
								sessionInfo,
								spaceName: params.space_name,
							};

							const processedResult = applyResultPostProcessing(
								invokeResult.result as CallToolResult,
								postProcessOptions
							);

							const warningsContent =
								invokeResult.warnings.length > 0
									? [
											{
												type: 'text' as const,
												text:
													(invokeResult.warnings.length === 1 ? 'Warning:\n' : 'Warnings:\n') +
													invokeResult.warnings.map((w) => `- ${w}`).join('\n') +
													'\n',
											},
										]
									: [];

							const durationMs = Date.now() - startTime;
							const responseContent = [...warningsContent, ...(processedResult.content as unknown[])];
							logGradioEvent(params.space_name || 'unknown-space', sessionInfo?.clientSessionId || 'unknown', {
								durationMs,
								isAuthenticated: !!hfToken,
								clientName: sessionInfo?.clientInfo?.name,
								clientVersion: sessionInfo?.clientInfo?.version,
								success,
								error: invokeResult.isError ? JSON.stringify(responseContent) : undefined,
								responseSizeBytes: JSON.stringify(responseContent).length,
								isDynamic: true,
							});

							return {
								content: responseContent,
								...(invokeResult.isError && { isError: true }),
							} as CallToolResult;
						}

						const toolResult = result as ToolResult;
						success = !toolResult.isError;

						const durationMs = Date.now() - startTime;
						logSearchQuery(dynamicSpaceToolConfig.name, loggedOperation, params, {
							...getLoggingOptions(),
							totalResults: toolResult.totalResults,
							resultsShared: toolResult.resultsShared,
							responseCharCount: toolResult.formatted.length,
							durationMs,
							success,
						});

						return {
							content: [{ type: 'text', text: toolResult.formatted }],
							...(toolResult.isError && { isError: true }),
						};
					} catch (err) {
						const durationMs = Date.now() - startTime;
						logGradioEvent(params.space_name || 'unknown-space', sessionInfo?.clientSessionId || 'unknown', {
							durationMs,
							isAuthenticated: !!hfToken,
							clientName: sessionInfo?.clientInfo?.name,
							clientVersion: sessionInfo?.clientInfo?.version,
							success: false,
							error: err,
							isDynamic: true,
						});
						throw err;
					}
				}

				const toolResult = await runWithQueryLogging(
					logSearchQuery,
					{
						methodName: dynamicSpaceToolConfig.name,
						query: loggedOperation,
						parameters: params,
						baseOptions: getLoggingOptions(),
						successOptions: (result) => ({
							totalResults: result.totalResults,
							resultsShared: result.resultsShared,
							responseCharCount: result.formatted.length,
						}),
					},
					async () => {
						const spaceTool = new SpaceTool(hfToken);
						const result = await spaceTool.execute(params, extra);
						return result as ToolResult;
					}
				);

				return {
					content: [{ type: 'text', text: toolResult.formatted }],
					...(toolResult.isError && { isError: true }),
				};
			}
		);

		// Register Gradio widget resource for OpenAI MCP client (skybridge)
		if (sessionInfo?.clientInfo?.name === 'openai-mcp') {
			logger.debug('Registering Gradio widget resource for skybridge client');
			const widgetConfig = createGradioWidgetResourceConfig(SERVER_VERSION);
			server.registerResource(widgetConfig.name, widgetConfig.uri, {}, async () => ({
				contents: [
					{
						uri: widgetConfig.uri,
						mimeType: widgetConfig.mimeType,
						text: widgetConfig.htmlContent,
						_meta: widgetConfig.metadata,
					},
				],
			}));
		}

		// Register Skills (SEP-2640) — `skill://` resources + `skill://index.json`.
		if (skillCatalog && hasSkills) {
			registerSkillResources(server, skillCatalog);
		}

		// Declare the function to apply tool states (we only need to call it if we are
		// applying the tool states either because we have a Gradio tool call (grNN_) or
		// we are responding to a ListToolsRequest). This also helps if there is a
		// mismatch between Client cache state and desired states for these specific tools.
		// NB: That may not always be the case, consider carefully whether you want a tool
		// included in the skipGradio check.
		const applyToolStates = async () => {
			logger.info(
				{
					mode: toolSelection.mode,
					reason: toolSelection.reason,
					enabledCount: toolSelection.enabledToolIds.length,
					totalTools: Object.keys(toolInstances).length,
					mixedBouquet: toolSelection.mixedBouquet?.join(','),
				},
				'Tool selection strategy applied'
			);

			// Apply the desired state to each tool (tools start enabled by default)
			for (const [toolName, toolInstance] of Object.entries(toolInstances)) {
				if (disabledTools.has(toolName)) {
					toolInstance.disable();
				} else if (toolSelection.enabledToolIds.includes(toolName)) {
					toolInstance.enable();
				} else {
					toolInstance.disable();
				}
			}
		};

		for (const [toolName, toolInstance] of Object.entries({ ...toolInstances, ...fixedToolInstances })) {
			disableConfiguredTool(toolName, toolInstance, disabledTools);
		}

		// Always register capabilities consistently for stateless vs stateful modes
		const transportInfo = sharedApiClient.getTransportInfo();

		registerCapabilities(server, sharedApiClient, {
			hasResources: !clientDenied && sessionInfo?.clientInfo?.name === 'openai-mcp',
			hasSkills,
		});

		if (!skipGradio) {
			void applyToolStates();

			if (!transportInfo?.jsonResponseEnabled && !transportInfo?.externalApiMode) {
				// Set up event listener for dynamic tool state changes
				const toolStateChangeHandler = (toolId: string, enabled: boolean) => {
					const toolInstance = toolInstances[toolId];
					if (toolInstance) {
						if (disabledTools.has(toolId)) {
							toolInstance.disable();
						} else if (
							enabled &&
							(!(AUTHENTICATED_BUILTIN_TOOL_IDS as readonly string[]).includes(toolId) || hfToken)
						) {
							toolInstance.enable();
						} else {
							toolInstance.disable();
						}
						logger.debug({ toolId, enabled }, 'Applied single tool state change');
					}
				};

				sharedApiClient.on('toolStateChange', toolStateChangeHandler);

				// Clean up event listener when server closes
				server.server.onclose = () => {
					sharedApiClient.removeListener('toolStateChange', toolStateChangeHandler);
					logger.debug('Removed toolStateChange listener for closed server');
				};
			}
		}
		return { server, userDetails, enabledToolIds: toolSelection.enabledToolIds };
	};
};
