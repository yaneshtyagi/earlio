import type { FastifyInstance } from 'fastify';
import { complianceRoutes } from './compliance/routes';
import { invoicingRoutes } from './invoicing/routes';
import { termsRoutes } from './terms/routes';
import { insuranceRoutes } from './insurance/routes';
import { marketplaceRoutes } from './marketplace/routes';
import { settlementRoutes } from './settlement/routes';
import { notifyRoutes } from './notify/routes';
import { relationshipRoutes } from './identity/relationship-routes';

/** Later milestones register their route plugins here. */
export async function registerModules(app: FastifyInstance): Promise<void> {
  complianceRoutes(app);
  relationshipRoutes(app);
  invoicingRoutes(app);
  termsRoutes(app);
  insuranceRoutes(app);
  marketplaceRoutes(app);
  settlementRoutes(app);
  notifyRoutes(app);
  // invoicing, terms, insurance, marketplace, settlement ... (added per milestone)
}
