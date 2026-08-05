import { Module } from "@nestjs/common";
import { EMAIL_PROVIDER } from "./email-provider.interface";
import { MailpitEmailProvider } from "./mailpit-email.provider";

@Module({
  providers: [{ provide: EMAIL_PROVIDER, useClass: MailpitEmailProvider }],
  exports: [EMAIL_PROVIDER],
})
export class EmailModule {}
