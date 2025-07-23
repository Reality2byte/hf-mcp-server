import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	ToolSelectionStrategy,
	ToolSelectionMode,
	BOUQUETS,
	type ToolSelectionContext,
} from '../../../src/server/utils/tool-selection-strategy.js';
import { McpApiClient, type ApiClientConfig } from '../../../src/server/utils/mcp-api-client.js';
import type { AppSettings } from '../../../src/shared/settings.js';
import type { TransportInfo } from '../../../src/shared/transport-info.js';
import { ALL_BUILTIN_TOOL_IDS, TOOL_ID_GROUPS } from '@llmindset/hf-mcp';
import { extractAuthBouquetAndMix } from '../../../src/server/utils/auth-utils.js';

describe('extractBouquetAndMix', () => {
	it('should extract bouquet from headers', () => {
		const headers = { 'x-mcp-bouquet': 'search' };
		const { bouquet, mix } = extractAuthBouquetAndMix(headers);

		expect(bouquet).toBe('search');
		expect(mix).toBeUndefined();
	});

	it('should extract mix from headers', () => {
		const headers = { 'x-mcp-mix': 'hf_api' };
		const result = extractAuthBouquetAndMix(headers);

		expect(result.bouquet).toBeUndefined();
		expect(result.mix).toBe('hf_api');
	});

	it('should extract both bouquet and mix from headers', () => {
		const headers = {
			'x-mcp-bouquet': 'search',
			'x-mcp-mix': 'hf_api',
		};
		const result = extractAuthBouquetAndMix(headers);

		expect(result.bouquet).toBe('search');
		expect(result.mix).toBe('hf_api');
	});

	it('should handle null headers', () => {
		const result = extractAuthBouquetAndMix(null);

		expect(result.bouquet).toBeUndefined();
		expect(result.mix).toBeUndefined();
	});

	it('should handle empty headers', () => {
		const result = extractAuthBouquetAndMix({});

		expect(result.bouquet).toBeUndefined();
		expect(result.mix).toBeUndefined();
	});
});

describe('BOUQUETS configuration', () => {
	it('should have correct hf_api bouquet', () => {
		const bouquet = BOUQUETS.hf_api;
		expect(bouquet).toBeDefined();
		if (bouquet) {
			expect(bouquet.builtInTools).toEqual(TOOL_ID_GROUPS.hf_api);
			expect(bouquet.spaceTools).toEqual([]);
		}
	});

	it('should have correct spaces bouquet', () => {
		const bouquet = BOUQUETS.spaces;
		expect(bouquet).toBeDefined();
		if (bouquet) {
			expect(bouquet.builtInTools).toEqual(TOOL_ID_GROUPS.spaces);
			expect(bouquet.spaceTools).toEqual([]);
		}
	});

	it('should have correct search bouquet', () => {
		const bouquet = BOUQUETS.search;
		expect(bouquet).toBeDefined();
		if (bouquet) {
			expect(bouquet.builtInTools).toEqual(TOOL_ID_GROUPS.search);
			expect(bouquet.spaceTools).toEqual([]);
		}
	});

	it('should have correct all bouquet', () => {
		const bouquet = BOUQUETS.all;
		expect(bouquet).toBeDefined();
		if (bouquet) {
			expect(bouquet.builtInTools).toEqual(ALL_BUILTIN_TOOL_IDS);
			expect(bouquet.spaceTools).toEqual([]);
		}
	});
});

describe('ToolSelectionStrategy', () => {
	let strategy: ToolSelectionStrategy;
	let mockApiClient: McpApiClient;

	// Create a real API client with minimal config for testing
	beforeEach(() => {
		const config: ApiClientConfig = {
			type: 'polling',
			baseUrl: 'http://localhost:3000',
			pollInterval: 5000,
			staticGradioEndpoints: [],
		};

		const transportInfo: TransportInfo = {
			transport: 'streamableHttpJson',
			port: 3000,
			defaultHfTokenSet: false,
			jsonResponseEnabled: true,
			externalApiMode: false,
			stdioClient: null,
		};

		mockApiClient = new McpApiClient(config, transportInfo);
		strategy = new ToolSelectionStrategy(mockApiClient);
	});

	describe('Bouquet Override (Highest Precedence)', () => {
		it('should use bouquet override for search bouquet', async () => {
			const context: ToolSelectionContext = {
				headers: { 'x-mcp-bouquet': 'search' },
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.BOUQUET_OVERRIDE);
			expect(result.enabledToolIds).toEqual(TOOL_ID_GROUPS.search);
			expect(result.reason).toBe('Bouquet override: search');
			expect(result.baseSettings).toBeUndefined();
			expect(result.mixedBouquet).toBeUndefined();
		});

		it('should use bouquet override for hf_api bouquet', async () => {
			const context: ToolSelectionContext = {
				headers: { 'x-mcp-bouquet': 'hf_api' },
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.BOUQUET_OVERRIDE);
			expect(result.enabledToolIds).toEqual(TOOL_ID_GROUPS.hf_api);
			expect(result.reason).toBe('Bouquet override: hf_api');
		});

		it('should use bouquet override for spaces bouquet', async () => {
			const context: ToolSelectionContext = {
				headers: { 'x-mcp-bouquet': 'spaces' },
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.BOUQUET_OVERRIDE);
			expect(result.enabledToolIds).toEqual(TOOL_ID_GROUPS.spaces);
			expect(result.reason).toBe('Bouquet override: spaces');
		});

		it('should use bouquet override for all bouquet', async () => {
			const context: ToolSelectionContext = {
				headers: { 'x-mcp-bouquet': 'all' },
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.BOUQUET_OVERRIDE);
			expect(result.enabledToolIds).toEqual(ALL_BUILTIN_TOOL_IDS);
			expect(result.reason).toBe('Bouquet override: all');
		});

		it('should ignore invalid bouquet names', async () => {
			const context: ToolSelectionContext = {
				headers: { 'x-mcp-bouquet': 'invalid_bouquet' },
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			// Should fall through to fallback since no valid bouquet or user settings
			expect(result.mode).toBe(ToolSelectionMode.FALLBACK);
			expect(result.enabledToolIds).toEqual(ALL_BUILTIN_TOOL_IDS);
		});

		it('should prefer bouquet over mix when both are present', async () => {
			const userSettings: AppSettings = {
				builtInTools: ['hf_semantic_search'],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: {
					'x-mcp-bouquet': 'search',
					'x-mcp-mix': 'hf_api',
				},
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.BOUQUET_OVERRIDE);
			expect(result.enabledToolIds).toEqual(TOOL_ID_GROUPS.search);
			expect(result.reason).toBe('Bouquet override: search');
		});
	});

	describe('Mix Mode (Second Precedence)', () => {
		it('should mix hf_api tools with user settings', async () => {
			const userSettings: AppSettings = {
				builtInTools: ['hf_semantic_search', 'hf_dataset_search'],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: { 'x-mcp-mix': 'hf_api' },
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.MIX);
			expect(result.reason).toBe('User settings + mix(hf_api)');
			expect(result.baseSettings).toEqual(userSettings);
			expect(result.mixedBouquet).toBe('hf_api');

			// Should contain user tools + hf_api tools (deduplicated)
			const expectedTools = [...new Set([...userSettings.builtInTools, ...TOOL_ID_GROUPS.hf_api])];
			expect(result.enabledToolIds).toEqual(expectedTools);
		});

		it('should mix search tools with user settings', async () => {
			const userSettings: AppSettings = {
				builtInTools: ['hf_whoami', 'hf_duplicate_space'],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: { 'x-mcp-mix': 'search' },
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.MIX);
			expect(result.reason).toBe('User settings + mix(search)');

			const expectedTools = [...new Set([...userSettings.builtInTools, ...TOOL_ID_GROUPS.search])];
			expect(result.enabledToolIds).toEqual(expectedTools);
		});

		it('should deduplicate tools when mixing', async () => {
			const userSettings: AppSettings = {
				builtInTools: ['hf_semantic_search', 'hf_model_search'], // Already has some search tools
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: { 'x-mcp-mix': 'search' },
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.MIX);

			// Should not have duplicates
			const uniqueTools = [...new Set(result.enabledToolIds)];
			expect(result.enabledToolIds).toEqual(uniqueTools);
			expect(result.enabledToolIds.length).toBe(uniqueTools.length);
		});

		it('should ignore mix when no user settings available', async () => {
			const context: ToolSelectionContext = {
				headers: { 'x-mcp-mix': 'hf_api' },
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			// Should fall through to fallback since no user settings to mix with
			expect(result.mode).toBe(ToolSelectionMode.FALLBACK);
			expect(result.enabledToolIds).toEqual(ALL_BUILTIN_TOOL_IDS);
		});

		it('should ignore invalid mix bouquet names', async () => {
			const userSettings: AppSettings = {
				builtInTools: ['hf_semantic_search'],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: { 'x-mcp-mix': 'invalid_mix' },
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			// Should use user settings without mixing
			expect(result.mode).toBe(ToolSelectionMode.INTERNAL_API);
			expect(result.enabledToolIds).toEqual(userSettings.builtInTools);
		});
	});

	describe('User Settings Mode (Third Precedence)', () => {
		it('should use provided user settings in internal API mode', async () => {
			const userSettings: AppSettings = {
				builtInTools: ['hf_semantic_search', 'hf_model_search'],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: {},
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.INTERNAL_API);
			expect(result.enabledToolIds).toEqual(userSettings.builtInTools);
			expect(result.reason).toBe('Internal API user settings');
			expect(result.baseSettings).toEqual(userSettings);
		});

		it('should use provided user settings in external API mode', async () => {
			// Create external API mode client
			const externalConfig: ApiClientConfig = {
				type: 'external',
				externalUrl: 'https://api.example.com/settings',
				hfToken: 'test-token',
			};

			const externalTransportInfo: TransportInfo = {
				transport: 'streamableHttpJson',
				port: 3000,
				defaultHfTokenSet: false,
				jsonResponseEnabled: true,
				externalApiMode: true,
				stdioClient: null,
			};

			const externalApiClient = new McpApiClient(externalConfig, externalTransportInfo);
			const externalStrategy = new ToolSelectionStrategy(externalApiClient);

			const userSettings: AppSettings = {
				builtInTools: ['hf_paper_search'],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: {},
				userSettings,
				hfToken: 'test-token',
			};

			const result = await externalStrategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.EXTERNAL_API);
			expect(result.enabledToolIds).toEqual(userSettings.builtInTools);
			expect(result.reason).toBe('External API user settings');
		});
	});

	describe('Fallback Mode (Lowest Precedence)', () => {
		it('should use fallback when no configuration is available', async () => {
			const context: ToolSelectionContext = {
				headers: {},
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.FALLBACK);
			expect(result.enabledToolIds).toEqual(ALL_BUILTIN_TOOL_IDS);
			expect(result.reason).toBe('Fallback - no settings available');
			expect(result.baseSettings).toBeUndefined();
		});

		it('should use fallback when headers are null', async () => {
			const context: ToolSelectionContext = {
				headers: null,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.FALLBACK);
			expect(result.enabledToolIds).toEqual(ALL_BUILTIN_TOOL_IDS);
		});
	});

	describe('Complex Scenarios', () => {
		it('should handle empty user settings', async () => {
			const userSettings: AppSettings = {
				builtInTools: [],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: {},
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.INTERNAL_API);
			expect(result.enabledToolIds).toEqual([]);
			expect(result.baseSettings).toEqual(userSettings);
		});

		it('should handle mix with empty user settings', async () => {
			const userSettings: AppSettings = {
				builtInTools: [],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: { 'x-mcp-mix': 'search' },
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.MIX);
			expect(result.enabledToolIds).toEqual(TOOL_ID_GROUPS.search);
			expect(result.mixedBouquet).toBe('search');
		});

		it('should handle all possible tool types in mix', async () => {
			const userSettings: AppSettings = {
				builtInTools: ['hf_whoami'], // Start with one tool
				spaceTools: [],
			};

			// Test mixing with each bouquet type
			for (const [bouquetName, bouquetConfig] of Object.entries(BOUQUETS)) {
				const context: ToolSelectionContext = {
					headers: { 'x-mcp-mix': bouquetName },
					userSettings,
					hfToken: 'test-token',
				};

				const result = await strategy.selectTools(context);

				expect(result.mode).toBe(ToolSelectionMode.MIX);
				expect(result.mixedBouquet).toBe(bouquetName);

				const expectedTools = [...new Set([...userSettings.builtInTools, ...bouquetConfig.builtInTools])];
				expect(result.enabledToolIds).toEqual(expectedTools);
			}
		});

		it('should preserve gradio endpoints when mixing with all bouquet in internal API mode', async () => {
			const userSettings: AppSettings = {
				builtInTools: ['hf_whoami'], // Most tools disabled via frontend
				spaceTools: [
					{
						name: 'My Custom GPT',
						subdomain: 'user123-my-custom-gpt',
						_id: 'custom-1',
						emoji: '🤖',
					},
					{
						name: 'Company Analytics',
						subdomain: 'corp-analytics-tool',
						_id: 'custom-2',
						emoji: '📊',
					},
				],
			};

			const context: ToolSelectionContext = {
				headers: { 'x-mcp-mix': 'all' },
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.MIX);
			expect(result.mixedBouquet).toBe('all');
			expect(result.reason).toBe('User settings + mix(all)');

			// Should get user's minimal tools + ALL built-in tools (deduplicated)
			const expectedBuiltInTools = [...new Set([...userSettings.builtInTools, ...ALL_BUILTIN_TOOL_IDS])];
			expect(result.enabledToolIds).toEqual(expectedBuiltInTools);

			// Should preserve base settings including gradio endpoints
			expect(result.baseSettings).toEqual(userSettings);
			expect(result.baseSettings?.spaceTools).toHaveLength(2);
			expect(result.baseSettings?.spaceTools).toEqual([
				{
					name: 'My Custom GPT',
					subdomain: 'user123-my-custom-gpt',
					_id: 'custom-1',
					emoji: '🤖',
				},
				{
					name: 'Company Analytics',
					subdomain: 'corp-analytics-tool',
					_id: 'custom-2',
					emoji: '📊',
				},
			]);
		});
	});

	describe('SEARCH_ENABLES_FETCH feature', () => {
		const originalEnv = process.env.SEARCH_ENABLES_FETCH;

		afterEach(() => {
			// Restore original env value
			if (originalEnv === undefined) {
				delete process.env.SEARCH_ENABLES_FETCH;
			} else {
				process.env.SEARCH_ENABLES_FETCH = originalEnv;
			}
		});

		it('should not auto-enable hf_doc_fetch when SEARCH_ENABLES_FETCH is not set', async () => {
			delete process.env.SEARCH_ENABLES_FETCH;

			const userSettings: AppSettings = {
				builtInTools: ['hf_doc_search', 'hf_model_search'],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: {},
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.enabledToolIds).toEqual(['hf_doc_search', 'hf_model_search']);
			expect(result.enabledToolIds).not.toContain('hf_doc_fetch');
		});

		it('should not auto-enable hf_doc_fetch when SEARCH_ENABLES_FETCH is false', async () => {
			process.env.SEARCH_ENABLES_FETCH = 'false';

			const userSettings: AppSettings = {
				builtInTools: ['hf_doc_search', 'hf_model_search'],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: {},
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.enabledToolIds).toEqual(['hf_doc_search', 'hf_model_search']);
			expect(result.enabledToolIds).not.toContain('hf_doc_fetch');
		});

		it('should auto-enable hf_doc_fetch when SEARCH_ENABLES_FETCH=true and hf_doc_search is enabled', async () => {
			process.env.SEARCH_ENABLES_FETCH = 'true';

			const userSettings: AppSettings = {
				builtInTools: ['hf_doc_search', 'hf_model_search'],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: {},
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.enabledToolIds).toContain('hf_doc_search');
			expect(result.enabledToolIds).toContain('hf_doc_fetch');
			expect(result.enabledToolIds).toContain('hf_model_search');
			expect(result.enabledToolIds).toHaveLength(3);
		});

		it('should not add hf_doc_fetch when hf_doc_search is not enabled', async () => {
			process.env.SEARCH_ENABLES_FETCH = 'true';

			const userSettings: AppSettings = {
				builtInTools: ['hf_model_search', 'hf_dataset_search'],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: {},
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.enabledToolIds).not.toContain('hf_doc_search');
			expect(result.enabledToolIds).not.toContain('hf_doc_fetch');
			expect(result.enabledToolIds).toEqual(['hf_model_search', 'hf_dataset_search']);
		});

		it('should not duplicate hf_doc_fetch if already enabled', async () => {
			process.env.SEARCH_ENABLES_FETCH = 'true';

			const userSettings: AppSettings = {
				builtInTools: ['hf_doc_search', 'hf_doc_fetch', 'hf_model_search'],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: {},
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.enabledToolIds).toEqual(['hf_doc_search', 'hf_doc_fetch', 'hf_model_search']);
			expect(result.enabledToolIds.filter((id) => id === 'hf_doc_fetch')).toHaveLength(1);
		});

		it('should work with bouquet override', async () => {
			process.env.SEARCH_ENABLES_FETCH = 'true';

			const context: ToolSelectionContext = {
				headers: { 'x-mcp-bouquet': 'search' },
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.BOUQUET_OVERRIDE);
			expect(result.enabledToolIds).toContain('hf_doc_search');
			expect(result.enabledToolIds).toContain('hf_doc_fetch');
		});

		it('should work with mix mode', async () => {
			process.env.SEARCH_ENABLES_FETCH = 'true';

			const userSettings: AppSettings = {
				builtInTools: ['hf_model_search'],
				spaceTools: [],
			};

			const context: ToolSelectionContext = {
				headers: { 'x-mcp-mix': 'search' },
				userSettings,
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.MIX);
			expect(result.enabledToolIds).toContain('hf_doc_search');
			expect(result.enabledToolIds).toContain('hf_doc_fetch');
			expect(result.enabledToolIds).toContain('hf_model_search');
		});

		it('should work with fallback mode when all tools are enabled', async () => {
			process.env.SEARCH_ENABLES_FETCH = 'true';

			const context: ToolSelectionContext = {
				headers: {},
				hfToken: 'test-token',
			};

			const result = await strategy.selectTools(context);

			expect(result.mode).toBe(ToolSelectionMode.FALLBACK);
			// In fallback mode, all tools are enabled, so both should already be there
			expect(result.enabledToolIds).toContain('hf_doc_search');
			expect(result.enabledToolIds).toContain('hf_doc_fetch');
		});
	});
});
