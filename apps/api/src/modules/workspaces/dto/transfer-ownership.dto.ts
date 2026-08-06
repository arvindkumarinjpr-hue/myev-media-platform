import { IsUUID } from "class-validator";

export class TransferOwnershipDto {
  /** Target user's publicId — must already be an ACTIVE member holding ADMIN. */
  @IsUUID()
  newOwnerUserPublicId!: string;
}
