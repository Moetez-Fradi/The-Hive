import { Global, Module } from '@nestjs/common';
import { HederaService } from './hedera.service';

@Global()
@Module({
  providers: [HederaService],
  exports: [HederaService],
})
export class HederaModule {}
