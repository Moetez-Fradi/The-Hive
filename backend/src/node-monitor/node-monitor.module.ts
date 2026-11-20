import { Module } from '@nestjs/common';
import { NodeMonitorService } from './node-monitor.service';

@Module({
  providers: [NodeMonitorService]
})
export class NodeMonitorModule {}
