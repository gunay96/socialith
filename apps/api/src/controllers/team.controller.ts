import type { NextFunction, Request, Response } from "express";
import { ERROR_CODES, type ApiResponse } from "@socialith/types";
import { ApiHttpError } from "../middleware/error-handler.js";
import {
  createInvitationSchema,
  changeRoleSchema,
  acceptInvitationSchema,
} from "../validation/team.validation.js";
import * as teamService from "../services/team.service.js";
import * as invitationService from "../services/invitation.service.js";
import { regenerateSession, establishSession } from "../lib/session.js";
import type { TeamMember } from "../repositories/team.repository.js";
import type { PendingInvitation } from "../repositories/invitation.repository.js";
import type { SafeUser } from "../types/auth.js";

export async function listTeam(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // requireAuth ran first; every authenticated role can view the team.
    const { members, pendingInvitations } = await teamService.getTeam(req.user!.organizationId);
    const body: ApiResponse<{ members: TeamMember[]; pendingInvitations: PendingInvitation[] }> = {
      success: true,
      data: { members, pendingInvitations },
    };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

export async function inviteMember(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = createInvitationSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "A valid email and role are required.");
    }

    // requireMinimumRole("ADMIN") ran first, so req.user is populated
    // and already known to be ADMIN or OWNER.
    const result = await invitationService.createInvitation(req.user!, parsed.data);

    const body: ApiResponse<invitationService.CreateInvitationResult> = { success: true, data: result };
    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
}

export async function changeRole(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = changeRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiHttpError(400, ERROR_CODES.INVALID_REQUEST, "A valid role is required.");
    }

    const updated = await teamService.changeMemberRole(req.user!, req.params.userId!, parsed.data.role);
    const body: ApiResponse<SafeUser> = { success: true, data: updated };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

export async function disableMember(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const updated = await teamService.disableMember(req.user!, req.params.userId!);
    const body: ApiResponse<SafeUser> = { success: true, data: updated };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

export async function enableMember(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const updated = await teamService.enableMember(req.user!, req.params.userId!);
    const body: ApiResponse<SafeUser> = { success: true, data: updated };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

export async function removeMember(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const updated = await teamService.removeMember(req.user!, req.params.userId!);
    const body: ApiResponse<SafeUser> = { success: true, data: updated };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

/** GET /api/team/invitations/:token — read-only preview, no auth required (the token itself is the credential). */
export async function previewInvitation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const preview = await invitationService.previewInvitation(req.params.token!);
    const body: ApiResponse<invitationService.InvitationPreview> = { success: true, data: preview };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}

/** POST /api/team/invitations/:token — accepts the invitation and establishes a session, same as login. */
export async function acceptInvitation(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = acceptInvitationSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ApiHttpError(
        400,
        ERROR_CODES.INVALID_REQUEST,
        parsed.error.issues[0]?.message ?? "Name and a valid password are required.",
      );
    }

    const { safeUser, sessionVersion } = await invitationService.acceptInvitation(req.params.token!, parsed.data);

    // Same session-establishment pattern as login (see
    // controllers/auth.controller.ts) — new session ID, then the
    // session payload. Assigned to a variable first (rather than
    // passed as `{ ...safeUser, sessionVersion }` directly) because a
    // spread object literal used inline as a call argument is still
    // subject to TypeScript's excess-property checking against
    // establishSession's narrower parameter type.
    await regenerateSession(req);
    const sessionUser = { ...safeUser, sessionVersion };
    establishSession(req, sessionUser);

    const body: ApiResponse<SafeUser> = { success: true, data: safeUser };
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
}
