import { ConflictException, Injectable } from "@nestjs/common";
import { Prisma } from "../../../generated/prisma";

const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_CONSTRAINT_VIOLATION;
}

/**
 * Module 1C Engineering Plan §1. Slug history is permanent: a slug, once
 * reserved, is never freed by anything in this module — not on rename
 * (the old reservation is left untouched), not on delete (nothing happens
 * to the reservation at all). Reservation rows are append-only; nothing in
 * this service ever updates or deletes one.
 *
 * The actual collision-detection mechanism is each reservation table's own
 * immediate (non-deferred) UNIQUE index — the INSERT below either succeeds
 * or fails atomically under concurrency; there is no separate "claim" step
 * that could race. The composite foreign keys from workspaces.slug /
 * projects.slug into these tables (deferred, added via raw SQL — see the
 * migration) are what make it a hard Postgres guarantee, not just an
 * application convention, that a resource's current slug always has a
 * matching reservation.
 */
@Injectable()
export class SlugReservationService {
  async reserveWorkspaceSlug(tx: Prisma.TransactionClient, workspaceId: string, slug: string): Promise<void> {
    try {
      await tx.workspaceSlugReservation.create({ data: { workspaceId, slug } });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictException({ code: "SLUG_ALREADY_RESERVED", message: "This workspace slug is not available." });
      }
      throw error;
    }
  }

  async isWorkspaceSlugAvailable(tx: Prisma.TransactionClient, slug: string): Promise<boolean> {
    const existing = await tx.workspaceSlugReservation.findUnique({ where: { slug } });
    return !existing;
  }

  async reserveProjectSlug(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    projectId: string,
    slug: string,
  ): Promise<void> {
    try {
      await tx.projectSlugReservation.create({ data: { workspaceId, projectId, slug } });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictException({ code: "SLUG_ALREADY_RESERVED", message: "This slug is not available in this workspace." });
      }
      throw error;
    }
  }

  async isProjectSlugAvailable(tx: Prisma.TransactionClient, workspaceId: string, slug: string): Promise<boolean> {
    const existing = await tx.projectSlugReservation.findUnique({ where: { workspaceId_slug: { workspaceId, slug } } });
    return !existing;
  }
}
