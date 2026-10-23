import type { FastifyInstance } from 'fastify';
import { complianceRoutes } from './compliance/routes';
import { invoicingRoutes } from './invoicing/routes';
import { relationshipRoutes } from './identity/relationship-routes';

/** Later milestones register their route plugins here. */
export async function registerModules(app: FastifyInstance): Promise<void> {
  complianceRoutes(app);
  relationshipRoutes(app);
  invoicingRoutes(app);
  // invoicing, terms, insurance, marketplace, settlement ... (added per milestone)
}
