import { Module } from '@nestjs/common';
import { NodeService } from './node.service';
import { NodeController } from './node.controller';

@Module({
  providers: [NodeService],
  controllers: [NodeController]
})
export class NodeModule {}
