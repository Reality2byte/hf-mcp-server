import { type Express } from 'express';
import { type TransportType } from '../shared/constants.js';
import type { TransportInfo } from '../shared/transport-info.js';
import { createTransport } from './transport/transport-factory.js';
import type { BaseTransport, ServerFactory } from './transport/base-transport.js';
import type { WebServer } from './web-server.js';
import { logger } from './lib/logger.js';
import { createServerFactory } from './mcp-server.js';
import { createProxyServerFactory } from './mcp-proxy.js';
import { McpApiClient, type ApiClientConfig, type GradioEndpoint } from './lib/mcp-api-client.js';
import type { SpaceTool } from '../shared/settings.js';
import { ALL_BUILTIN_TOOL_IDS } from '@hf-mcp/mcp';

export interface ApplicationOptions {
	transportType: TransportType;
	webAppPort: number;
	webServerInstance: WebServer;
	apiClientConfig?: ApiClientConfig; // Optional - defaults to polling mode
}

/**
 * Main application class that coordinates web server, MCP server factory, and transport lifecycle
 */
export class Application {
	private serverFactory: ServerFactory;
	private webServerInstance: WebServer;
	private appInstance: Express;
	private transport?: BaseTransport;
	private apiClient: McpApiClient;
	private transportType: TransportType;
	private webAppPort: number;
	private isDev: boolean;

	constructor(options: ApplicationOptions) {
		this.transportType = options.transportType;
		this.webAppPort = options.webAppPort;
		this.webServerInstance = options.webServerInstance;
		this.isDev = process.env.NODE_ENV === 'development';

		// Create transport info first
		const defaultHfToken = process.env.DEFAULT_HF_TOKEN;
		const transportInfo: TransportInfo = {
			transport: this.transportType,
			port: this.webAppPort,
			defaultHfTokenSet: !!defaultHfToken,
			hfTokenMasked: defaultHfToken ? maskToken(defaultHfToken) : undefined,
			jsonResponseEnabled: this.transportType === 'streamableHttpJson',
			stdioClient: this.transportType === 'stdio' ? null : undefined,
		};

		// Configure API client with transport info
		// Convert spaceTools to GradioEndpoints format for backward compatibility
		const convertSpaceToolsToGradioEndpoints = (spaceTools: SpaceTool[]): GradioEndpoint[] => {
			return spaceTools.map((spaceTool) => ({
				name: spaceTool.name,
				subdomain: spaceTool.subdomain,
				id: spaceTool._id,
				emoji: spaceTool.emoji,
			}));
		};

		// Default space tools (will be used if no external API is configured)
		const defaultSpaceTools = [
			{
				_id: '6755d0d9e0ea01e11fa2a38a',
				name: 'evalstate/flux1_schnell',
				subdomain: 'evalstate-flux1-schnell',
				emoji: '🏎️💨',
			},
			{
				_id: '680be03dc38b7fa7d6855910',
				name: 'abidlabs/EasyGhibli',
				subdomain: 'abidlabs-easyghibli',
				emoji: '🦀',
			},
		];

		const defaultGradioEndpoints = convertSpaceToolsToGradioEndpoints(defaultSpaceTools);

		let apiClientConfig: ApiClientConfig;

		// Check for USER_CONFIG_API environment variable
		const userConfigApi = process.env.USER_CONFIG_API;
		if (userConfigApi) {
			// Use external mode with the user config API
			apiClientConfig = {
				type: 'external',
				externalUrl: userConfigApi,
				hfToken: process.env.HF_TOKEN || process.env.DEFAULT_HF_TOKEN,
			};
			logger.info(`Using external API client with user config API: ${userConfigApi}`);
		} else {
			// Default to polling mode
			apiClientConfig = options.apiClientConfig || {
				type: 'polling',
				baseUrl: `http://localhost:${String(this.webAppPort)}`,
				pollInterval: 5000,
				staticGradioEndpoints: defaultGradioEndpoints,
			};
			logger.info(`Using internal API client with user config API: ${apiClientConfig.baseUrl}}`);
		}
		this.apiClient = new McpApiClient(apiClientConfig, transportInfo);

		// Create the server factory
		const originalServerFactory = createServerFactory(this.webServerInstance, this.apiClient);

		// Wrap with proxy (for now just passes through, later will add remote tools)
		this.serverFactory = createProxyServerFactory(this.webServerInstance, this.apiClient, originalServerFactory);

		// Get Express app instance
		this.appInstance = this.webServerInstance.getApp();
	}

	async start(): Promise<void> {
		// Set transport info (already created in constructor)
		const transportInfo = this.apiClient.getTransportInfo();
		if (transportInfo) {
			this.webServerInstance.setTransportInfo(transportInfo);
		}

		// Setup tool management for web server
		this.setupToolManagement();

		// Configure API endpoints
		this.webServerInstance.setupApiRoutes();

		// Start web server FIRST
		await this.startWebServer();

		// Initialize transport (before static files to avoid route conflicts)
		await this.initializeTransport();

		// Setup static files (must be AFTER transport routes to avoid catch-all conflicts)
		await this.webServerInstance.setupStaticFiles(this.isDev);

		// Start API client (global tool management)
		await this.startToolManagement();
	}

	private setupToolManagement(): void {
		// For web server tool management, create placeholder registered tools
		// In a full implementation, tool enable/disable would be managed differently
		const registeredTools: { [toolId: string]: { enable: () => void; disable: () => void } } = {};

		// Create placeholder registered tools for web server compatibility
		ALL_BUILTIN_TOOL_IDS.forEach((toolName) => {
			registeredTools[toolName] = {
				enable: () => {
					// Emit tool state change event to update actual MCP tools
					this.apiClient.emit('toolStateChange', toolName, true);
				},
				disable: () => {
					// Emit tool state change event to update actual MCP tools
					this.apiClient.emit('toolStateChange', toolName, false);
				},
			};
		});

		// Pass registered tools to WebServer
		this.webServerInstance.setRegisteredTools(registeredTools);

		// Pass API client to WebServer for Gradio endpoints
		this.webServerInstance.setApiClient(this.apiClient);
	}

	private async initializeTransport(): Promise<void> {
		if (this.transportType === 'unknown') return;

		try {
			this.transport = createTransport(this.transportType, this.serverFactory, this.appInstance);

			// Pass transport to web server for session management
			this.webServerInstance.setTransport(this.transport);

			await this.transport.initialize({
				port: this.webAppPort,
			});
		} catch (error) {
			logger.error({ error }, `Error initializing ${this.transportType} transport`);
			throw error;
		}
	}

	private async startWebServer(): Promise<void> {
		// WebServer manages its own lifecycle
		await this.webServerInstance.start(this.webAppPort);
		logger.info(`Server running at http://localhost:${String(this.webAppPort)}`);
		logger.info(
			{ transportType: this.transportType, mode: this.isDev ? 'development with HMR' : 'production' },
			'Server configuration'
		);
		if (this.isDev) {
			logger.info('HMR is active - frontend changes will be automatically reflected in the browser');
			logger.info("For server changes, use 'npm run dev:watch' to automatically rebuild and apply changes");
		}
	}

	private async startToolManagement(): Promise<void> {
		// Start API client for global tool state management
		await this.apiClient.startPolling((toolId, enabled) => {
			logger.debug(`Global tool ${toolId} ${enabled ? 'enabled' : 'disabled'}`);
		});
	}

	async stop(): Promise<void> {
		// Stop global API client
		this.apiClient.stopPolling();
		// Signal transport to stop accepting new connections
		if (this.transport?.shutdown) {
			this.transport.shutdown();
		}

		logger.info('Shutting down web server...');
		await this.webServerInstance.stop();

		// Clean up transport if initialized
		if (this.transport) {
			await this.transport.cleanup();
		}
	}

	getExpressApp(): Express {
		return this.appInstance;
	}
}

export function maskToken(token: string): string {
	if (!token || token.length <= 9) return token;
	return `${token.substring(0, 4)}...${token.substring(token.length - 5)}`;
}
