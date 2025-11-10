/**
 * Two-level cache system for Gradio endpoint discovery
 *
 * Cache 1: Space metadata from HuggingFace API (with ETag support)
 * Cache 2: Gradio schemas from Gradio endpoints
 */

import { logger } from './logger.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

/**
 * Configuration for cache TTLs and timeouts
 */
export const CACHE_CONFIG = {
	// Space metadata cache TTL (default: 5 minutes)
	SPACE_METADATA_TTL: parseInt(process.env.GRADIO_SPACE_CACHE_TTL || '300000', 10),

	// Schema cache TTL (default: 5 minutes)
	SCHEMA_TTL: parseInt(process.env.GRADIO_SCHEMA_CACHE_TTL || '300000', 10),

	// Discovery concurrency (default: 10 parallel requests)
	DISCOVERY_CONCURRENCY: parseInt(process.env.GRADIO_DISCOVERY_CONCURRENCY || '10', 10),

	// Space info timeout (default: 5 seconds)
	SPACE_INFO_TIMEOUT: parseInt(process.env.GRADIO_SPACE_INFO_TIMEOUT || '5000', 10),

	// Schema fetch timeout (default: 12 seconds)
	SCHEMA_TIMEOUT: parseInt(process.env.GRADIO_SCHEMA_TIMEOUT || '12000', 10),
};

/**
 * Cached space metadata from HuggingFace API
 */
export interface CachedSpaceMetadata {
	// Core space data
	_id: string;           // e.g., "gradio_evalstate-flux1-schnell"
	name: string;          // e.g., "evalstate/flux1_schnell"
	subdomain: string;     // e.g., "evalstate-flux1-schnell"
	emoji: string;         // e.g., "🔧"
	private: boolean;      // Used for auth header forwarding
	sdk: string;           // e.g., "gradio", "static", "streamlit"

	// Optional runtime info
	runtime?: {
		stage?: string;    // "RUNNING", "SLEEPING", etc.
		hardware?: string;
	};

	// Cache metadata
	etag?: string;         // For conditional requests (If-None-Match)
	fetchedAt: number;     // Timestamp for TTL calculation
}

/**
 * Cached Gradio schema
 */
export interface CachedSchema {
	// Schema data
	tools: Tool[];         // Array of tool definitions with inputSchema

	// Cache metadata
	fetchedAt: number;     // Timestamp (no ETag available from Gradio endpoints)
}

/**
 * Cache statistics for observability
 */
export interface CacheStats {
	metadataHits: number;
	metadataMisses: number;
	metadataEtagRevalidations: number;
	schemaHits: number;
	schemaMisses: number;
	metadataCacheSize: number;
	schemaCacheSize: number;
}

/**
 * In-memory cache for space metadata
 */
class SpaceMetadataCache {
	private cache = new Map<string, CachedSpaceMetadata>();
	private stats = {
		hits: 0,
		misses: 0,
		etagRevalidations: 0,
	};

	/**
	 * Get cached metadata if valid (within TTL)
	 */
	get(spaceName: string): CachedSpaceMetadata | null {
		const entry = this.cache.get(spaceName);

		if (!entry) {
			this.stats.misses++;
			logger.trace({ spaceName }, 'Space metadata cache miss');
			return null;
		}

		const age = Date.now() - entry.fetchedAt;
		const isValid = age < CACHE_CONFIG.SPACE_METADATA_TTL;

		if (!isValid) {
			this.stats.misses++;
			logger.trace({ spaceName, age, ttl: CACHE_CONFIG.SPACE_METADATA_TTL }, 'Space metadata cache expired');
			return null;
		}

		this.stats.hits++;
		logger.trace({ spaceName, age }, 'Space metadata cache hit');
		return entry;
	}

	/**
	 * Get cached metadata regardless of TTL (for ETag revalidation)
	 */
	getForRevalidation(spaceName: string): CachedSpaceMetadata | null {
		return this.cache.get(spaceName) || null;
	}

	/**
	 * Set or update cached metadata
	 */
	set(spaceName: string, metadata: CachedSpaceMetadata): void {
		this.cache.set(spaceName, metadata);
		logger.trace({ spaceName, hasEtag: !!metadata.etag }, 'Space metadata cached');
	}

	/**
	 * Update timestamp after ETag revalidation (304 response)
	 */
	updateTimestamp(spaceName: string): void {
		const entry = this.cache.get(spaceName);
		if (entry) {
			entry.fetchedAt = Date.now();
			this.stats.etagRevalidations++;
			logger.trace({ spaceName }, 'Space metadata timestamp updated after 304');
		}
	}

	/**
	 * Clear all cached entries
	 */
	clear(): void {
		this.cache.clear();
		logger.debug('Space metadata cache cleared');
	}

	/**
	 * Get cache statistics
	 */
	getStats(): { hits: number; misses: number; etagRevalidations: number; size: number } {
		return {
			hits: this.stats.hits,
			misses: this.stats.misses,
			etagRevalidations: this.stats.etagRevalidations,
			size: this.cache.size,
		};
	}
}

/**
 * In-memory cache for Gradio schemas
 */
class SchemaCache {
	private cache = new Map<string, CachedSchema>();
	private stats = {
		hits: 0,
		misses: 0,
	};

	/**
	 * Get cached schema if valid (within TTL)
	 */
	get(spaceName: string): CachedSchema | null {
		const entry = this.cache.get(spaceName);

		if (!entry) {
			this.stats.misses++;
			logger.trace({ spaceName }, 'Schema cache miss');
			return null;
		}

		const age = Date.now() - entry.fetchedAt;
		const isValid = age < CACHE_CONFIG.SCHEMA_TTL;

		if (!isValid) {
			this.stats.misses++;
			logger.trace({ spaceName, age, ttl: CACHE_CONFIG.SCHEMA_TTL }, 'Schema cache expired');
			return null;
		}

		this.stats.hits++;
		logger.trace({ spaceName, age, toolCount: entry.tools.length }, 'Schema cache hit');
		return entry;
	}

	/**
	 * Set or update cached schema
	 */
	set(spaceName: string, schema: CachedSchema): void {
		this.cache.set(spaceName, schema);
		logger.trace({ spaceName, toolCount: schema.tools.length }, 'Schema cached');
	}

	/**
	 * Clear all cached entries
	 */
	clear(): void {
		this.cache.clear();
		logger.debug('Schema cache cleared');
	}

	/**
	 * Get cache statistics
	 */
	getStats(): { hits: number; misses: number; size: number } {
		return {
			hits: this.stats.hits,
			misses: this.stats.misses,
			size: this.cache.size,
		};
	}
}

/**
 * Module-level singleton cache instances
 */
export const spaceMetadataCache = new SpaceMetadataCache();
export const schemaCache = new SchemaCache();

/**
 * Get combined cache statistics
 */
export function getCacheStats(): CacheStats {
	const metadataStats = spaceMetadataCache.getStats();
	const schemaStats = schemaCache.getStats();

	return {
		metadataHits: metadataStats.hits,
		metadataMisses: metadataStats.misses,
		metadataEtagRevalidations: metadataStats.etagRevalidations,
		schemaHits: schemaStats.hits,
		schemaMisses: schemaStats.misses,
		metadataCacheSize: metadataStats.size,
		schemaCacheSize: schemaStats.size,
	};
}

/**
 * Clear all caches
 */
export function clearAllCaches(): void {
	spaceMetadataCache.clear();
	schemaCache.clear();
	logger.info('All Gradio caches cleared');
}

/**
 * Log cache statistics at debug level
 */
export function logCacheStats(): void {
	const stats = getCacheStats();

	const metadataHitRate = stats.metadataHits + stats.metadataMisses > 0
		? (stats.metadataHits / (stats.metadataHits + stats.metadataMisses) * 100).toFixed(1)
		: '0.0';

	const schemaHitRate = stats.schemaHits + stats.schemaMisses > 0
		? (stats.schemaHits / (stats.schemaHits + stats.schemaMisses) * 100).toFixed(1)
		: '0.0';

	logger.debug({
		metadata: {
			hits: stats.metadataHits,
			misses: stats.metadataMisses,
			etagRevalidations: stats.metadataEtagRevalidations,
			hitRate: `${metadataHitRate}%`,
			cacheSize: stats.metadataCacheSize,
		},
		schema: {
			hits: stats.schemaHits,
			misses: stats.schemaMisses,
			hitRate: `${schemaHitRate}%`,
			cacheSize: stats.schemaCacheSize,
		},
	}, 'Gradio cache statistics');
}
