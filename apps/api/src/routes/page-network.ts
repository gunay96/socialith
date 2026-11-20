import { Router } from "express";
import * as c from "../controllers/page-network.controller.js";
import { requireAuth } from "../middleware/auth.js";
import { requireMinimumRole } from "../middleware/rbac.js";

/**
 * Page Network. Mounted at "/api". Reading is open to every authenticated role (like /campaigns and /publishing);
 * creating, editing, archiving, grouping, linking destinations and assigning pages to campaigns are administrator
 * actions (ADMIN and above) - the brief names administrators for every one of them. Internal notes and provider
 * internals are filtered out of the responses for roles below EDITOR (see canSeeInternal).
 */
export function createPageNetworkRouter(): Router {
  const r = Router();
  const read = [requireAuth];
  const admin = [requireAuth, requireMinimumRole("ADMIN")];
  const base = "/page-network";

  r.get(`${base}/overview`, ...read, c.getOverview);
  r.get(`${base}/mapping`, ...read, c.getMapping);
  r.get(`${base}/formats`, ...read, c.listFormats);

  r.get(`${base}/categories`, ...read, c.listCategories);
  r.post(`${base}/categories`, ...admin, c.createCategory);
  r.post(`${base}/categories/starters`, ...admin, c.addStarterCategories);
  r.get(`${base}/categories/:id`, ...read, c.getCategory);
  r.patch(`${base}/categories/:id`, ...admin, c.updateCategory);
  r.post(`${base}/categories/:id/archive`, ...admin, c.archiveCategory);
  r.post(`${base}/categories/:id/restore`, ...admin, c.restoreCategory);

  r.get(`${base}/pages`, ...read, c.listPages);
  r.post(`${base}/pages`, ...admin, c.createPage);
  r.get(`${base}/pages/:id`, ...read, c.getPage);
  r.patch(`${base}/pages/:id`, ...admin, c.updatePage);
  r.get(`${base}/pages/:id/identity`, ...read, c.getIdentity);
  r.put(`${base}/pages/:id/identity`, ...admin, c.updateIdentity);
  r.post(`${base}/pages/:id/archive`, ...admin, c.archivePage);
  r.post(`${base}/pages/:id/restore`, ...admin, c.restorePage);
  r.get(`${base}/pages/:id/destination-candidates`, ...read, c.destinationCandidates);
  r.put(`${base}/pages/:id/destination`, ...admin, c.setDestination);
  r.post(`${base}/pages/:id/check-text`, ...read, c.checkText);

  r.get(`${base}/groups`, ...read, c.listGroups);
  r.post(`${base}/groups`, ...admin, c.createGroup);
  r.get(`${base}/groups/:id`, ...read, c.getGroup);
  r.patch(`${base}/groups/:id`, ...admin, c.updateGroup);
  r.post(`${base}/groups/:id/archive`, ...admin, c.archiveGroup);
  r.post(`${base}/groups/:id/restore`, ...admin, c.restoreGroup);
  r.post(`${base}/groups/:id/members`, ...admin, c.addGroupMembers);
  r.delete(`${base}/groups/:id/members/:pageId`, ...admin, c.removeGroupMember);

  r.get(`${base}/campaigns/:id`, ...read, c.getCampaignPages);
  r.post(`${base}/campaigns/:id/assignments`, ...admin, c.assignCampaign);
  r.delete(`${base}/campaigns/:id/pages/:pageId`, ...admin, c.unassignCampaignPage);
  r.delete(`${base}/campaigns/:id/groups/:groupId`, ...admin, c.unassignCampaignGroup);
  r.get(`${base}/campaigns/:id/content`, ...read, c.campaignContent);

  return r;
}
