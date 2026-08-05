export interface AccessTokenPayload {
  sub: string; // user public_id
  sessionId: string; // session public_id
  familyId: string;
}
