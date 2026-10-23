import type { FastifyInstance } from 'fastify';

/** Later milestones register their route plugins here. */
export async function registerModules(_app: FastifyInstance): Promise<void> {
  // compliance, invoicing, terms, insurance, marketplace, settlement ... (added per milestone)
}
